import { isNoise } from "../util.js";

// ava lists what failed, then details each one under a rule:
//
//   ✘ [fail]: totals an invoice
//   ─
//   totals an invoice
//
//   av/sum.test.js:3
//    3: test("totals an invoice", (t) => { t.is(total([1000, 49], 0.5), 1050); });
//
//   Difference (- actual, + expected):
//   - 1049
//   + 1050
//
//   › file://av/sum.test.js:3:38
//
//   2 tests failed
//
// The roll-call carries the names and the tally identifies the tool; the detail blocks
// carry the location. A test that throws says so on the roll-call line and details the
// throw instead of a difference.
const ROLL_RE = /^[^\S\n]*✘[^\S\n]+\[fail\]:[^\S\n]+(.+?)[^\S\n]*$/;
const TALLY_RE = /^[^\S\n]*(\d+) tests? failed\b/m;
const UNCAUGHT_RE = /^[^\S\n]*Uncaught exception in[^\S\n]+(\S+)[^\S\n]*$/;
const EXITED_RE = /^[^\S\n]*✘[^\S\n]+(\S+) exited with a non-zero exit code/m;
// "av/sum.test.js:3" on its own line, under the repeated test name
const WHERE_RE = /^[^\S\n]*(\S+\.\w+):(\d+)[^\S\n]*$/;
// "› file:///abs/av/sum.test.js:3:38" - the frame ava points at
const FRAME_RE = /^[^\S\n]*›[^\S\n]+(?:file:\/\/)?(\S+?):(\d+):(\d+)[^\S\n]*$/;
const CLASS_RE = /^[^\S\n]*(\w*(?:Error|Exception)):[^\S\n]*(.*)$/;
const THREW_RE = /^[^\S\n]*(\w*(?:Error|Exception)) thrown in test:?[^\S\n]*$/;
const DIFF_RE = /^[^\S\n]*Difference \(- actual, \+ expected\):/;
// ava echoes the source around the failing line as "   4: test(...)"; that is context,
// not the diagnosis.
const SOURCE_RE = /^[^\S\n]*\d+:[^\S\n]/;
// An assertion that is not a difference says so in prose and puts the value under it:
// "Value is not truthy:" / "undefined". Without this the message fell back to the test
// name, which tells the reader nothing they did not already have.
const ASSERTION_RE = /^[^\S\n]*([A-Z][^:]{3,60}):[^\S\n]*$/;
// A throw's location is in a node-style frame rather than ava's own pointer.
const AT_RE = /^[^\S\n]+at[^\S\n]+(?:.+?[^\S\n]+\()?(?:file:\/\/)?(\/[^\s()]+?):(\d+):(\d+)\)?[^\S\n]*$/;
const RULE_RE = /^[^\S\n]*─[^\S\n]*$/;
const MAX_MESSAGE_LINES = 4;
const unfile = (p) => (p.startsWith("file://") ? decodeURIComponent(p.slice(7)) : p);

export default {
  name: "ava",
  category: "test",
  commands: ["ava"],

  detect: (s) =>
    TALLY_RE.test(s) ||
    /^[^\S\n]*\d+ uncaught exceptions?\b/m.test(s) ||
    s.split("\n").some((l) => ROLL_RE.test(l)),

  extract(s) {
    const lines = s.split("\n");
    const failures = [];

    // Names first: the roll-call is the only place every failure is listed once.
    const names = [];
    for (const l of lines) {
      const m = l.match(ROLL_RE);
      if (m) names.push(m[1].replace(/[^\S\n]+\w*(?:Error|Exception) thrown in test$/, "").trim());
    }

    // Where each name's detail block begins, found in one pass. Scanning the whole log
    // per name made this quadratic - and cubic with the inner loop's own lookup - so a
    // log with a few thousand roll-call lines took seconds. The fuzzer builds exactly
    // that by duplicating lines, and it hung CI for half an hour.
    const nameSet = new Set(names);
    const blockAt = new Map();
    lines.forEach((l, i) => {
      if (i === 0 || ROLL_RE.test(l)) return;
      const t = l.trim();
      if (nameSet.has(t) && !blockAt.has(t)) blockAt.set(t, i);
    });

    for (const name of names) {
      // The detail block repeats the name alone on a line, after the rule.
      const at = blockAt.get(name) ?? -1;
      if (at < 0) { failures.push({ title: name, subject: name, severity: "error", message: name }); continue; }

      let where = null, message = "", code, threw = false;
      const diff = [];
      for (let j = at + 1; j < lines.length && j <= at + 40; j++) {
        if (RULE_RE.test(lines[j])) break;
        const here = lines[j].trim();
        if (here !== name && nameSet.has(here)) break;   // the next failure's block

        if (SOURCE_RE.test(lines[j])) continue;

        const f = lines[j].match(FRAME_RE);
        if (f && !isNoise(unfile(f[1]))) { where ??= { file: unfile(f[1]), line: +f[2], col: +f[3] }; continue; }
        const a = lines[j].match(AT_RE);
        if (a) { if (!where && !isNoise(a[1])) where = { file: a[1], line: +a[2], col: +a[3] }; continue; }
        const w = lines[j].match(WHERE_RE);
        if (w && !where) { where = { file: w[1], line: +w[2] }; continue; }

        const t = lines[j].match(THREW_RE);
        if (t) { threw = true; code = t[1]; continue; }
        const c = lines[j].match(CLASS_RE);
        if (c && threw && !message) { code = c[1]; message = c[2].trim(); continue; }

        if (DIFF_RE.test(lines[j])) {
          for (let k = j + 1; k < lines.length && k <= j + 8 && diff.length < MAX_MESSAGE_LINES; k++) {
            if (!lines[k].trim()) { if (diff.length) break; else continue; }
            if (!/^[^\S\n]*[-+]/.test(lines[k])) break;
            diff.push(lines[k].trim());
          }
          continue;
        }

        // Anything else that reads as prose ending in a colon is the assertion, and the
        // line under it is the value it is talking about.
        const as = lines[j].match(ASSERTION_RE);
        if (as && !message && !threw) {
          message = as[1].trim();
          // ava puts a blank line between the assertion and the value it is about.
          let k = j + 1;
          while (k < lines.length && !lines[k].trim()) k++;
          const value = lines[k]?.trim();
          if (value && !RULE_RE.test(lines[k]) && !FRAME_RE.test(lines[k]) && !SOURCE_RE.test(lines[k])) {
            message += `\n${value}`;
          }
        }
      }

      failures.push({
        file: where?.file, line: where?.line, col: where?.col,
        // The site that failed is the test, so that is the subject - and `code` is its
        // alternative, not its companion. A thrown class belongs in the title, where it
        // says what kind of failure this was without claiming to be the identity.
        title: threw && code ? `${name} (${code})` : name,
        subject: name, severity: "error",
        message: message || (diff.length ? diff.join("\n") : name),
      });
    }

    if (!failures.length) {
      // A file that will not load never reaches the roll-call.
      const at = lines.findIndex((l) => UNCAUGHT_RE.test(l));
      if (at >= 0) {
        const file = lines[at].match(UNCAUGHT_RE)[1];
        let why = null, seen = 0;
        for (let j = at + 1; j < lines.length && seen < 3; j++) {
          if (!lines[j].trim()) continue;
          seen++;
          const m = lines[j].match(CLASS_RE);
          if (m) { why = m; break; }
        }
        failures.push({
          file, title: why ? why[1] : "uncaught exception",
          code: why ? why[1] : undefined,
          label: why ? undefined : "uncaught exception",
          severity: "error",
          message: why ? why[2].trim() : "ava could not run this file",
        });
      } else {
        const exited = s.match(EXITED_RE);
        if (exited) {
          failures.push({
            file: exited[1], title: "exited non-zero", label: "exited non-zero",
            severity: "error", message: "the test file exited with a non-zero code",
          });
        }
      }
    }
    if (!failures.length) return null;

    const tally = s.match(TALLY_RE);
    return {
      tool: "ava",
      summary: tally ? `${tally[1]} test${tally[1] === "1" ? "" : "s"} failed` : undefined,
      failures,
    };
  },
};
