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
const MARKED_RE = /^[^\S\n]*>[^\S\n]*\d+[^\S\n]*\|[^\S\n]?(.*)$/;
const GUTTER_RE = /^[^\S\n]*\d+[^\S\n]*\|/;
const CARET_RE = /^[^\S\n]*\|[^\S\n]*\^/;
// A path to an artifact to go and open is not a description of the failure.
const ARTIFACT_RE = /^[^\S\n]*(?:Error Context|attachment|Attachment):/;
// The run's tally closes the last failure's block; without it the count lands inside
// the message of whichever failure happened to be last.
const TALLY_RE = /^[^\S\n]*\d+ (?:failed|passed|skipped|flaky)[^\S\n]*$/;
const MAX_MESSAGE = 4;

export default {
  name: "playwright",
  category: "test",
  commands: ["playwright"],

  detect: (s) =>
    /^Running \d+ tests? using \d+ worker/m.test(s) ||
    HEAD_RE.test(s.split("\n").find((l) => HEAD_RE.test(l)) ?? ""),

  extract(s) {
    const lines = s.split("\n");
    const failures = [];
    for (let i = 0; i < lines.length; i++) {
      const h = lines[i].match(HEAD_RE);
      if (!h) continue;
      let file = h[2], line = +h[3], col = +h[4];
      const message = [];
      let stmt;
      for (let j = i + 1; j < lines.length && !HEAD_RE.test(lines[j]) && !TALLY_RE.test(lines[j]); j++) {
        // the `at` inside the block is where it actually threw, which beats the test's
        // own declaration line
        const at = lines[j].match(AT_RE);
        if (at) { file = at[1]; line = +at[2]; col = +at[3]; continue; }
        const marked = lines[j].match(MARKED_RE);
        if (marked) { stmt ??= marked[1].trim(); continue; }
        if (GUTTER_RE.test(lines[j]) || CARET_RE.test(lines[j]) || ARTIFACT_RE.test(lines[j])) continue;
        const t = lines[j].trim();
        if (t && message.length < MAX_MESSAGE) message.push(t);
      }
      failures.push({
        file, line, col, title: h[5], subject: h[5], severity: "error",
        message: message.join("\n"), stmt,
      });
    }
    if (!failures.length) return null;
    const tally = s.match(/^[^\S\n]*(\d+) failed[^\S\n]*$/m);
    const n = Number(tally?.[1] ?? failures.length);
    return { tool: "playwright", summary: `${n} failed`, failures };
  },
};
