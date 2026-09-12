import { isNoise, xmlAttributes, xmlText } from "../util.js";

// node writes stack paths as file:// URLs when a module throws; bun writes plain paths,
// but a bun process running an ESM entry can produce either.
const unfile = (p) => (p.startsWith("file://") ? decodeURIComponent(p.slice(7)) : p);

// `bun test` prints the failure and THEN says whose it was:
//
//   274 |         expect(fn(input)).toEqual(expected);
//                                   ^
//   error: expect(received).toEqual(expected)
//
//   - { "path": "/" }
//   + false
//
//   - Expected  - 4
//   + Received  + 1
//
//         at <anonymous> (/abs/path/src/index.spec.ts:274:27)
//   (fail) suite > name > should do the thing [3.10ms]
//
// Reading forward from the "(fail)" line therefore gave every failure the NEXT one's
// message and location, and gave the last one the run's tally - "0 pass" reported as a
// test's assertion. Every bun run with more than one failure was wrong that way, and
// the corpus could not show it: the only fixture was a run of 192 near-identical
// parameterised cases whose blocks differ by one character.
//
// A block belongs to the "(fail)" line under it, back as far as the previous one. A
// "(fail)" whose block is not in the log - the capture began mid-run, which is how that
// fixture was taken - is still a test bun said had failed, and is still reported.
//
// Note bun writes "error:" at the start of a line, which the cargo parser also
// looks for - so this must be registered ahead of it.
const FAIL_RE = /^\(fail\)[^\S\n]+(.+?)(?:[^\S\n]+\[[\d.]+m?s\])?[^\S\n]*$/;
const ERROR_RE = /^error:[^\S\n]*(.+)$/;
const AT_RE = /^[^\S\n]*at[^\S\n]+.*?\((.+?):(\d+):(\d+)\)[^\S\n]*$/;
const SOURCE_RE = /^[^\S\n]*\d+[^\S\n]*\|/;              // bun's echoed source context
const CARET_RE = /^[^\S\n]*\^+[^\S\n]*$/;
const DIFF_COUNT_RE = /^[-+][^\S\n]*(Expected|Received)[^\S\n]+[-+][^\S\n]*\d+[^\S\n]*$/;
// What bun writes above the first block: its own banner, and the file it is about to
// run. Neither is a diagnosis, and the first failure's block starts at the top of the
// log, so without these the run's version string was reported as its assertion.
const BANNER_RE = /^bun test v[\d.]+/;
// What a run says about a test whose own output is not in the log - the capture began
// mid-run, or the format never carried it. Worded once so both places say it alike.
const NO_BLOCK = "bun reported this test as failed; its output is not in this log";

// --reporter=junit writes a document that records WHICH tests failed and nothing else:
// every outcome is a bare `<failure type="AssertionError" />` with no message and no
// body. Nothing read it, so a CI job keeping only the XML got no diagnosis at all -
// where the names, the file and the line each test is declared on were all sitting in it.
//
// JUnit is a shape every runner writes, so the bound is the suite bun names itself. The
// suites nest - a describe block inside a file - and cases hang off both levels, so the
// document is read whole rather than a level at a time.
const BUN_DOC_RE = /<testsuites\b[^>]*\bname="bun test"[^>]*>([\s\S]*?)<\/testsuites>/g;
const BUN_SUITES = /<testsuites\b[^>]*\bname="bun test"/;
const CASE_RE = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
const OUTCOME_RE = /<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/;

/** The failed cases of a `--reporter=junit` document, or none. */
function junitCases(s) {
  if (!BUN_SUITES.test(s)) return [];
  const out = [];
  const mine = [...s.matchAll(BUN_DOC_RE)].map((d) => d[1]).join("\n");
  for (const test of mine.matchAll(CASE_RE)) {
    const body = test[2] ?? "";
    const outcome = body.match(OUTCOME_RE);
    if (!outcome) continue;
    const a = xmlAttributes(test[1]);
    const detail = xmlText(outcome[3] ?? "").trim() || xmlAttributes(outcome[2]).message || "";
    // The describe block is the classname, and bun's own reporter writes the two with a
    // chevron between them. A test declared outside one has no classname at all.
    const name = [a.classname, a.name].filter(Boolean).join(" > ");
    out.push({
      file: a.file, line: /^\d+$/.test(a.line) ? +a.line : undefined,
      // The test's name is what identifies it; the outcome's `type` is a class name
      // with nothing behind it in this format, and a failure carries one handle or the
      // other, never both.
      title: name, subject: name, severity: "error",
      message: detail || NO_BLOCK,
    });
  }
  return out;
}
const FILE_HEAD_RE = /^\S+:[^\S\n]*$/;
const MAX_MESSAGE_LINES = 4;

export default {
  name: "bun test",
  category: "test",
  commands: ["bun"],
  detect: (s) => (/^\(fail\)[^\S\n]+/m.test(s) &&
    (/^Ran \d+ tests? across/m.test(s) || /^[^\S\n]*\d+ fail[^\S\n]*$/m.test(s))) ||
    junitCases(s).length > 0,

  extract(s) {
    const lines = s.split("\n");
    const failures = [];

    // Where the first failure's block may start. bun opens a run with its own banner,
    // so that is the earliest anything below can belong to it - and when the capture
    // began mid-run there is no banner, and the first "(fail)" has no block at all.
    // Without this the first failure reached back into whatever tool ran before bun,
    // and "error: could not compile" from cargo became a bun test's assertion.
    const banner = lines.findIndex((l) => BANNER_RE.test(l));
    let from = banner < 0 ? null : banner + 1;
    for (let i = 0; i < lines.length; i++) {
      const head = lines[i].match(FAIL_RE);
      if (!head) continue;

      // The block is bounded by its own shape, not by how far back the previous
      // "(fail)" was. Everything bun prints in one is a source echo, a caret, its
      // "error:" line, the detail under it, or a frame - so the walk back stops at the
      // first line that is none of those, and cannot reach a progress bar, a banner, or
      // another tool. Above the "error:" line bun draws only the source it points at.
      const lo = from ?? i;             // no banner above: this failure has no block
      let start = lo;
      let sawError = false;
      for (let j = i - 1; j >= lo; j--) {
        const raw = lines[j];
        const t = raw.trim();
        if (!t) { start = j; continue; }
        if (sawError) {
          if (SOURCE_RE.test(raw) || CARET_RE.test(raw)) { start = j; continue; }
          start = j + 1;
          break;
        }
        if (ERROR_RE.test(t)) { sawError = true; start = j; continue; }
        if (AT_RE.test(raw) || SOURCE_RE.test(raw) || CARET_RE.test(raw)) { start = j; continue; }
        // what bun prints under "error:" - the diff, and the pair it compared
        if (/^[-+]/.test(t) || /^(?:Expected|Received):/.test(t)) { start = j; continue; }
        start = j + 1;
        break;
      }

      let file, line, col;
      const msg = [];
      for (let j = start; j < i; j++) {
        const at = lines[j].match(AT_RE);
        if (at) { if (!file) { file = at[1]; line = +at[2]; col = +at[3]; } continue; }
        const t = lines[j].trim();
        if (!t || msg.length >= MAX_MESSAGE_LINES) continue;
        // the echoed source, its caret, and the diff's own tallies are not the message
        if (SOURCE_RE.test(lines[j]) || CARET_RE.test(lines[j]) || DIFF_COUNT_RE.test(t)) continue;
        if (BANNER_RE.test(t) || FILE_HEAD_RE.test(t)) continue;
        const err = t.match(ERROR_RE);
        msg.push(err ? err[1] : t);
      }
      from = i + 1;
      failures.push({
        file, line, col, title: head[1], subject: head[1], severity: "error",
        // A failure whose block is not in the log still happened. Saying so is the
        // whole of what the log supports; taking the next test's block is not.
        message: msg.length ? msg.join("\n") : NO_BLOCK,
      });
    }

    // ...and the document, when a job kept that as well as - or instead of - the
    // console output. A test already read from the console is not read again.
    const said = new Set(failures.map((f) => f.subject));
    for (const f of junitCases(s)) {
      if (said.has(f.subject)) continue;
      said.add(f.subject);
      failures.push(f);
    }

    if (!failures.length) return null;

    const num = (k) => {
      const m = s.match(new RegExp(String.raw`^[^\S\n]*(\d+)[^\S\n]+${k}[^\S\n]*$`, "m"));
      return m ? +m[1] : null;
    };
    const [failed, passed] = [num("fail"), num("pass")];
    const bits = [];
    if (failed) bits.push(`${failed} fail`);
    if (passed) bits.push(`${passed} pass`);
    // The document prints no tally line; it counts the same things on its root suite.
    if (!bits.length) {
      const root = s.match(/<testsuites\b[^>]*\bname="bun test"[^>]*>/);
      const counts = root ? xmlAttributes(root[0]) : {};
      const fails = Number(counts.failures ?? 0) + Number(counts.errors ?? 0);
      const total = Number(counts.tests ?? 0);
      if (fails) bits.push(`${fails} fail`);
      if (total - fails > 0) bits.push(`${total - fails} pass`);
    }

    return { tool: "bun test", summary: bits.length ? bits.join(", ") : undefined, failures };
  },
};

// `bun script.ts` - a crash, not a test run. Bun stamps its own version at the foot of
// one, which nothing else writes, so that is what identifies the tool:
//
//   2 |   charge() { throw new Error("payment gateway unreachable"); }
//                            ^
//   error: payment gateway unreachable
//         at charge (/abs/bthrow.ts:2:24)
//         at /abs/bthrow.ts:4:15
//
//   Bun v1.3.14 (macOS arm64)
//
// Without this the node parser claimed it - the frames are node-shaped enough - and a
// `bun` command was reported as having failed under node.
const BUN_FOOTER = /^Bun v[\d.]+[^\S\n]+\(/m;
// bun writes the class for a thrown builtin and a bare "error:" for its own diagnostics.
const RUNTIME_ERR_RE = /^(?:(\w*(?:Error|Exception)): |error: )(.+)$/;
// Frames come both ways: named with parentheses, and bare when there is no function.
const RUNTIME_AT_RE = /^[^\S\n]+at[^\S\n]+(?:(.+?)[^\S\n]+\()?(.+?):(\d+):(\d+)\)?[^\S\n]*$/;
const RUNTIME_SRC_RE = /^[^\S\n]*(\d+)[^\S\n]*\|[^\S\n]?(.*)$/;

export const bunRuntime = {
  name: "bun",
  category: "runtime",
  commands: ["bun", "bunx"],
  detect: (s) => BUN_FOOTER.test(s),

  extract(s) {
    const lines = s.split("\n");
    // A crash is one message, and it ends at the footer. "error: <anything>" belongs to
    // half the tools in existence - cargo writes it, deno writes it - so scanning the
    // whole log for one meant that with the footer present this parser claimed every
    // such line in a log holding more than one tool. It did so 120 times.
    //
    // Walking back from the footer finds it: blank lines and frames first, then the
    // message. Stopping AT the message rather than treating it as one more thing a
    // crash is made of matters - cargo ends a build with "error: could not compile ...",
    // and with that line directly above bun's block the walk went straight past bun's
    // own message and took cargo's.
    const foot = lines.findIndex((l) => /^Bun v[\d.]+[^\S\n]+\(/.test(l));
    if (foot < 0) return null;

    let at = foot - 1;
    while (at >= 0 && (!lines[at].trim() || RUNTIME_AT_RE.test(lines[at]))) at--;
    const m = at >= 0 ? lines[at].match(RUNTIME_ERR_RE) : null;
    if (!m) return null;

    const frames = [];
    for (let j = at + 1; j < foot; j++) {
      const f = lines[j].match(RUNTIME_AT_RE);
      if (!f) { if (frames.length) break; else continue; }
      frames.push({ fn: f[1] ?? "<anonymous>", file: unfile(f[2]), line: +f[3], col: +f[4] });
    }
    const user = frames.filter((f) => !isNoise(f.file));
    const where = user[0] ?? frames[0];

    // The echoed source sits directly above the message, numbered, with a caret under
    // the column. Only those two shapes, so the walk cannot reach into another tool.
    let stmt;
    if (where) {
      for (let j = at - 1; j >= 0 && j >= at - 8; j--) {
        if (!RUNTIME_SRC_RE.test(lines[j]) && !CARET_RE.test(lines[j])) break;
        const src = lines[j].match(RUNTIME_SRC_RE);
        if (src && +src[1] === where.line) { stmt = src[2].trim(); break; }
      }
    }

    const failures = [{
      file: where?.file, line: where?.line, col: where?.col,
      // A thrown builtin names its class, which is the searchable handle. bun's own
      // diagnostics write a bare "error:" - a constant it prints for a whole class of
      // failure, which is what `label` is for, and the two are alternatives.
      title: m[1] ?? "error", code: m[1], label: m[1] ? undefined : "error",
      severity: "error", message: m[2], stmt,
      trace: user.slice(0, 4).map((f) => `${f.fn} (${f.file}:${f.line}:${f.col})`),
      hiddenFrames: frames.length - user.length,
    }];
    if (!failures.length) return null;
    return { tool: "bun", failures };
  },
};
