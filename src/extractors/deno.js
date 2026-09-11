// `deno test` gathers its failures under an ERRORS banner:
//
//    ERRORS
//
//   invoice total => ./math_test.ts:4:6
//   error: AssertionError: Values are not equal.
//
//       [Diff] Actual / Expected
//
//   -   1049
//   +   1050
//
//     throw new AssertionError(message);
//           ^
//       at assertEquals (https://jsr.io/@std/assert/1.0.19/equals.ts:67:9)
//
//   FAILED | 1 passed | 2 failed (15ms)
//
// The header line carries the test name and its location together, which is all
// the location we need - the stack frames below it are inside the assert library.
import { SOURCE_RANGE } from "../ownership.js";

const HEADER_RE = /^(\S.*?)[^\S\n]+=>[^\S\n]+(\S+?):(\d+):(\d+)[^\S\n]*$/;
const SUMMARY_RE = /^(?:FAILED|ok)[^\S\n]*\|[^\S\n]*(\d+)[^\S\n]+passed[^\S\n]*\|[^\S\n]*(\d+)[^\S\n]+failed/m;
const ERROR_RE = /^error:[^\S\n]*(.+)$/;
const DIFF_LABEL_RE = /^\[Diff\]/;
const THROW_RE = /^throw new |^\^+$/;
const MAX_MESSAGE_LINES = 4;

const denoPretty = {
  name: "deno test",
  category: "test",
  commands: ["deno"],
  detect: (s) => /^[^\S\n]*ERRORS[^\S\n]*$/m.test(s) && SUMMARY_RE.test(s),

  extract(s) {
    const lines = s.split("\n");
    const failures = [];

    for (let i = 0; i < lines.length; i++) {
      const head = lines[i].match(HEADER_RE);
      if (!head) continue;

      // deno writes "error: <Class>: <message>" on the line straight under the header,
      // every time. Scanning forward for any line at all meant that when two tools write
      // into one pipe and the block comes back shredded, whatever landed in between
      // became this test's assertion - a clang diagnostic read as a deno failure. If the
      // error line is not there, this is not a block we can read.
      let at = i + 1;
      while (at < lines.length && !lines[at].trim()) at++;
      if (at >= lines.length || !ERROR_RE.test(lines[at].trim())) continue;

      const msg = [];
      for (let j = at; j < lines.length && !HEADER_RE.test(lines[j]); j++) {
        const t = lines[j].trim();
        if (!t || msg.length >= MAX_MESSAGE_LINES) continue;
        // the FAILURES roll-call and the final tally end the block
        if (/^FAILURES[^\S\n]*$/.test(t) || SUMMARY_RE.test(t) || /^error: Test failed[^\S\n]*$/.test(t)) break;
        if (/^at\s/.test(t) || DIFF_LABEL_RE.test(t) || THROW_RE.test(t)) continue;
        const err = t.match(ERROR_RE);
        msg.push(err ? err[1] : t);
      }
      if (!msg.length) continue;
      failures.push({
        file: head[2], line: +head[3], col: +head[4],
        title: head[1], subject: head[1], severity: "error", message: msg.join("\n"),
      });
    }

    if (!failures.length) return null;
    const m = s.match(SUMMARY_RE);
    return {
      tool: "deno test",
      summary: m ? `${m[2]} failed, ${m[1]} passed` : undefined,
      failures,
    };
  },
};

const TAP_VERSION_RE = /^TAP version \d+[^\S\n]*$/m;
const TAP_NOT_OK_RE = /^[^\S\n]*not ok[^\S\n]+\d+[^\S\n]*-?[^\S\n]*(.*?)[^\S\n]*$/;
const TAP_END_RE = /^[^\S\n]*\.\.\.[^\S\n]*$/;

function xmlText(value) {
  return String(value).replace(/&(?:#(\d+)|#x([\da-f]+)|quot|apos|lt|gt|amp);/gi, (entity, dec, hex) => {
    if (dec || hex) {
      const point = dec ? Number(dec) : parseInt(hex, 16);
      return Number.isInteger(point) && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
        ? String.fromCodePoint(point)
        : entity;
    }
    return { "&quot;": '"', "&apos;": "'", "&lt;": "<", "&gt;": ">", "&amp;": "&" }[entity.toLowerCase()];
  });
}

function xmlAttributes(tag) {
  const attributes = {};
  for (const match of tag.matchAll(/([\w:.-]+)="([^"]*)"/g)) {
    attributes[match[1]] = xmlText(match[2]);
  }
  return attributes;
}

function usefulMessage(value) {
  const messageLines = value.split("\n");
  const first = messageLines[0]?.trim();
  const caret = messageLines.findIndex((line) => /^\s*\^+\s*$/.test(line));
  const candidate = caret > 0 ? messageLines[caret - 1].trim() : undefined;
  const stmt = candidate && !/^throw new /.test(candidate) ? candidate : undefined;
  return [first, stmt].filter(Boolean).join("\n");
}

/** Deno's TAP reporter puts one JSON diagnostic inside each TAP YAML block. */
function denoTapFailures(text) {
  if (!TAP_VERSION_RE.test(text) || !/^error:[^\S\n]+Test failed[^\S\n]*$/m.test(text)) return [];
  const lines = text.split("\n");
  const failures = [];
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i].match(TAP_NOT_OK_RE);
    if (!head) continue;
    for (let j = i + 1; j < lines.length && j <= i + 20; j++) {
      if (TAP_NOT_OK_RE.test(lines[j]) || TAP_END_RE.test(lines[j])) break;
      const candidate = lines[j].trim();
      if (!candidate.startsWith("{") || !candidate.endsWith("}") ||
          !/"severity"\s*:\s*"fail"/.test(candidate)) continue;
      let value;
      try { value = JSON.parse(candidate); } catch { continue; }
      if (value?.severity !== "fail" || typeof value?.message !== "string" ||
          typeof value?.at?.file !== "string" || !Number.isInteger(value?.at?.line)) continue;
      const failure = {
        file: value.at.file, line: value.at.line,
        title: head[1] || "test", subject: head[1] || "test", severity: "error",
        message: usefulMessage(value.message),
      };
      Object.defineProperty(failure, SOURCE_RANGE, {
        value: { start: i, end: j + 1 }, enumerable: false,
      });
      failures.push(failure);
      break;
    }
  }
  return failures;
}

/** `--junit-path=-` writes the XML to stdout ALONGSIDE whatever reporter is running, so
 *  a single run arrives twice - once as the human report, once as XML. Adding both
 *  counted one failure as two, and with the TAP reporter it showed the same test twice.
 *
 *  The tell is adjacency, which is what Deno itself guarantees: the XML follows the
 *  other report's closing tally immediately, with nothing between but the declaration.
 *  Two separate runs always have a run boundary in between - `error: Test failed`, or
 *  the next run's `Check`/`running` line - so a second run is never mistaken for this. */
function precededByItsOwnRun(lines, rootAt) {
  for (let i = rootAt - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line || /^<\?xml\b/.test(line)) continue;
    return /^(?:FAILED|ok)[^\S\n]*\|[^\S\n]*\d+[^\S\n]+passed[^\S\n]*\|[^\S\n]*\d+[^\S\n]+failed/.test(line) ||
      /^1\.\.\d+$/.test(line);
  }
  return false;
}

/** Deno's JUnit reporter, bounded by its own `testsuites name="deno test"` root. */
function denoJunit(text) {
  const lines = text.split("\n");
  const failures = [];
  let passed = 0;
  for (let rootAt = 0; rootAt < lines.length; rootAt++) {
    if (!/<testsuites\b[^>]*\bname="deno test"/.test(lines[rootAt])) continue;
    const root = xmlAttributes(lines[rootAt]);
    let rootEnd = rootAt + 1;
    while (rootEnd < lines.length && !/<\/testsuites>/.test(lines[rootEnd])) rootEnd++;
    // The same run, already reported above in another form. It has nothing to add.
    if (precededByItsOwnRun(lines, rootAt)) { rootAt = rootEnd; continue; }
    for (let i = rootAt + 1; i < rootEnd; i++) {
      if (!/<testcase\b/.test(lines[i])) continue;
      const test = xmlAttributes(lines[i]);
      for (let j = i + 1; j < rootEnd && !/<\/testcase>/.test(lines[j]); j++) {
        const open = lines[j].match(/<(failure|error)\b[^>]*>(.*)$/);
        if (!open) continue;
        const close = new RegExp(`</${open[1]}>`);
        const body = [open[2]];
        let end = j;
        while (end < rootEnd && !close.test(body.at(-1))) body.push(lines[++end] ?? "");
        const decoded = xmlText(body.join("\n").replace(new RegExp(`</${open[1]}>[\\s\\S]*$`), ""));
        const failure = {
          file: test.classname, line: /^\d+$/.test(test.line) ? +test.line : undefined,
          col: /^\d+$/.test(test.col) ? +test.col : undefined,
          title: test.name || "test", subject: test.name || "test", severity: "error",
          message: usefulMessage(decoded),
        };
        Object.defineProperty(failure, SOURCE_RANGE, {
          value: { start: i, end: end + 1 }, enumerable: false,
        });
        failures.push(failure);
        i = end;
        break;
      }
    }
    const tests = /^\d+$/.test(root.tests) ? +root.tests : 0;
    const failed = (/^\d+$/.test(root.failures) ? +root.failures : 0) +
      (/^\d+$/.test(root.errors) ? +root.errors : 0);
    const skipped = lines.slice(rootAt + 1, rootEnd)
      .filter((line) => /<skipped\b/.test(line)).length;
    passed += Math.max(0, tests - failed - skipped);
    rootAt = rootEnd;
  }
  return { failures, passed };
}

export default {
  ...denoPretty,

  detect(text) {
    return denoTapFailures(text).length > 0 || denoJunit(text).failures.length > 0 || denoPretty.detect(text);
  },

  extract(text) {
    const tap = denoTapFailures(text);
    const junit = denoJunit(text);
    if (!tap.length && !junit.failures.length) return denoPretty.extract(text);
    const pretty = denoPretty.extract(text);
    const failures = [...(pretty?.failures ?? []), ...tap, ...junit.failures];
    const tapPassed = text.split("\n")
      .filter((line) => /^[^\S\n]*ok[^\S\n]+\d+\b/.test(line) &&
        !/#[^\S\n]*(?:SKIP|TODO)\b/i.test(line)).length;
    const prettyPassed = [...text.matchAll(/^(?:FAILED|ok)[^\S\n]*\|[^\S\n]*(\d+)[^\S\n]+passed[^\S\n]*\|[^\S\n]*\d+[^\S\n]+failed/gm)]
      .reduce((sum, match) => sum + Number(match[1]), 0);
    return {
      tool: "deno test",
      summary: `${failures.length} failed, ${tapPassed + prettyPassed + junit.passed} passed`,
      failures,
    };
  },
};
