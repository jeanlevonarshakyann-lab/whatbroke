import { jsonDocuments, stripAnsi, xmlAttributes, xmlText } from "../util.js";
// Playwright numbers each failure and heads it with the location of the TEST, then the
// error, then an excerpt of the source with the offending line marked, then the location
// of the THROW, then a path to an artifact:
//
//   1) tests/a.spec.ts:2:5 › adds up ──────────────────
//     Error: expect(received).toBe(expected)
//     Expected: 1050
//     Received: 1049
//       > 3 |   expect(1049).toBe(1050);
//         at /abs/tests/a.spec.ts:3:16
//     Error Context: test-results/tests-a-adds-up/error-context.md
//
// The fallback read the first Error: line and both "Error Context:" paths, so a run with
// two failures came back as three, two of which were the names of files to go and read.
const HEAD_RE = /^[^\S\n]*(\d+)\)[^\S\n]+(\S+?):(\d+):(\d+)[^\S\n]+›[^\S\n]+(.+?)[^\S\n]*(?:[─—-]{3,})?[^\S\n]*$/;
// The throw's own location is more precise than the test's, and is what you want.
const AT_RE = /^[^\S\n]*at[^\S\n]+(\S+?):(\d+):(\d+)[^\S\n]*$/;
// The excerpt marks the offending line with a chevron.
const MARKED_RE = /^[^\S\n]*>[^\S\n]*(\d+)[^\S\n]*\|[^\S\n]?(.*)$/;
// The marked line is the one that threw, so its number is the throw's line. Taking the
// first marked line in the block quoted another failure's source whenever two captures
// of a run shared a log line by line, and the two readings of one failure then quoted
// different lines and were kept as two.
const quoted = (marked, line) => (marked.find((m) => m.n === line) ?? marked[0])?.text;
const GUTTER_RE = /^[^\S\n]*\d+[^\S\n]*\|/;
const CARET_RE = /^[^\S\n]*\|[^\S\n]*\^/;
// A path to an artifact to go and open is not a description of the failure.
const ARTIFACT_RE = /^[^\S\n]*(?:Error Context|attachment|Attachment):/;
// The run's tally closes the last failure's block; without it the count lands inside
// the message of whichever failure happened to be last.
const TALLY_RE = /^[^\S\n]*\d+ (?:failed|passed|skipped|flaky)[^\S\n]*$/;
// --reporter=github follows each block with the same failure as a workflow annotation,
// and the line reporter's progress - `[3/3] tests/cart.spec.ts:12:5 › counts items` -
// can land right after a block. Neither is part of the failure above it: the annotation
// ended up in the message, the whole block over again, and the next test's name after it.
const ANNOTATION_RE = /^[^\S\n]*::(?:error|warning|notice)[^\S\n:]/;
const PROGRESS_RE = /^[^\S\n]*\[\d+\/\d+\][^\S\n]/;
const MAX_MESSAGE = 4;

// --reporter=junit writes each failure's body as exactly the block above, without the
// number in front of the heading:
//
//   <testcase name="totals an invoice" classname="cart.spec.ts" time="0.003">
//   <failure message="expect(received).toBe(expected) // Object.is equality" type="expect.toBe">
//   <![CDATA[  cart.spec.ts:3:5 › totals an invoice ─────────────────────────────
//       Error: expect(received).toBe(expected) // Object.is equality
//       ...
//
// The document names no tool - `<testsuites id="" name="">` - so what makes a body
// Playwright's is that heading, with its chevron and its rule.
const JUNIT_HEAD_RE = /^[^\S\n]*()(\S+?):(\d+):(\d+)[^\S\n]+›[^\S\n]+(.+?)[^\S\n]*[─—-]{3,}[^\S\n]*$/;
// A self-closing `<error .../>` has no body, and must not be read as an opening tag: its
// "body" then ran to the next `</error>` in the log, which was the first of Playwright's -
// shellcheck's checkstyle report, written just above, took it with it.
const JUNIT_OUTCOME_RE = /<(failure|error)\b(?:[^>]*?\/>|[^>]*>([\s\S]*?)<\/\1>)/g;
const CDATA_RE = /<!\[CDATA\[([\s\S]*?)\]\]>/g;

// --reporter=json is the run as a document: suites nested by file and describe block,
// specs under them, and a result per attempt carrying the error, where it was thrown,
// and the source around it. Its messages keep the terminal's colours as escape codes.
const REPORT = (v) => !!v && typeof v === "object" && !!v.config && Array.isArray(v.suites) &&
  !!v.stats && Number.isInteger(v.stats.unexpected);

/** The failed tests of a JSON report, with the describe blocks they sit in. */
function reported(report) {
  const out = [];
  const walk = (suite, titles) => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        // "unexpected" is a test that did not end the way it was expected to; a flaky
        // one failed and then passed, and is not a failure of the run.
        if (test.status !== "unexpected") continue;
        const result = (test.results ?? []).find((r) => r?.error) ?? test.results?.[0];
        const error = result?.error ?? {};
        const at = result?.errorLocation ?? error.location;
        const name = [...titles, spec.title].join(" › ");
        const stmt = quoted(String(error.snippet ?? "").split("\n").map(stripAnsi)
          .map((l) => l.match(MARKED_RE)).filter(Boolean).map((m) => ({ n: +m[1], text: m[2].trim() })), at?.line);
        out.push({
          file: at?.file ?? spec.file, line: at?.line ?? spec.line, col: at?.column ?? spec.column,
          title: name, subject: name, severity: "error",
          message: stripAnsi(String(error.message ?? "")).split("\n").map((l) => l.trim()).filter(Boolean)
            .slice(0, MAX_MESSAGE).join("\n"),
          ...(stmt ? { stmt } : {}),
        });
      }
    }
    // The first level is the file, which the heading already names by its location.
    for (const child of suite.suites ?? []) walk(child, [...titles, child.title]);
  };
  for (const file of report.suites) walk(file, []);
  return out;
}

/** The failure blocks in `lines`, each under a heading `headRe` recognises. */
function blocks(lines, headRe) {
  const failures = [];
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(headRe);
    if (!h) continue;
    let file = h[2], line = +h[3], col = +h[4];
    const message = [];
    const marked = [];
    for (let j = i + 1; j < lines.length && !headRe.test(lines[j]) && !TALLY_RE.test(lines[j]) &&
      !ANNOTATION_RE.test(lines[j]); j++) {
      if (PROGRESS_RE.test(lines[j])) continue;
      // the `at` inside the block is where it actually threw, which beats the test's
      // own declaration line
      const at = lines[j].match(AT_RE);
      if (at) { file = at[1]; line = +at[2]; col = +at[3]; continue; }
      const mark = lines[j].match(MARKED_RE);
      if (mark) { marked.push({ n: +mark[1], text: mark[2].trim() }); continue; }
      if (GUTTER_RE.test(lines[j]) || CARET_RE.test(lines[j]) || ARTIFACT_RE.test(lines[j])) continue;
      const t = lines[j].trim();
      if (t && message.length < MAX_MESSAGE) message.push(t);
    }
    failures.push({
      file, line, col, title: h[5], subject: h[5], severity: "error",
      message: message.join("\n"), stmt: quoted(marked, line),
    });
  }
  return failures;
}

function junit(s) {
  if (!s.includes("<testcase")) return [];
  const out = [];
  for (const outcome of s.matchAll(JUNIT_OUTCOME_RE)) {
    if (outcome[2] === undefined) continue;
    const body = outcome[2].includes("<![CDATA[")
      ? [...outcome[2].matchAll(CDATA_RE)].map((m) => m[1]).join("\n")
      : xmlText(outcome[2]);
    const lines = body.split("\n");
    const first = lines.findIndex((l) => l.trim());
    if (first < 0 || !JUNIT_HEAD_RE.test(lines[first])) continue;
    out.push(...blocks(lines.slice(first), JUNIT_HEAD_RE));
  }
  return out;
}

const reports = (s) => (s.includes('"unexpected"') ? [...jsonDocuments(s, REPORT)] : []);

export default {
  name: "playwright",
  category: "test",
  commands: ["playwright"],

  detect: (s) =>
    /^Running \d+ tests? using \d+ worker/m.test(s) ||
    // The heading's chevron is the one character every console block carries.
    (s.includes("›") && HEAD_RE.test(s.split("\n").find((l) => HEAD_RE.test(l)) ?? "")) ||
    reports(s).some((r) => r.stats.unexpected > 0) || junit(s).length > 0,

  extract(s) {
    const lines = s.split("\n");
    const documents = reports(s);
    const failures = [...(s.includes("›") ? blocks(lines, HEAD_RE) : []), ...junit(s), ...documents.flatMap(reported)];
    if (!failures.length) return null;
    const tally = s.match(/^[^\S\n]*(\d+) failed[^\S\n]*$/m);
    const counted = documents.length ? documents.reduce((n, r) => n + r.stats.unexpected, 0) : null;
    const n = Number(tally?.[1] ?? counted ?? failures.length);
    return { tool: "playwright", summary: `${n} failed`, failures };
  },
};
