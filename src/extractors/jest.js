// With multiple jest projects the display name comes first: "FAIL jsdom src/a.js".
// Take the last token, which is always the path.
const FILE_RE = /^[^\S\n]*(?:FAIL|PASS)[^\S\n]+(?:\S+[^\S\n]+)*?(\S+)[^\S\n]*$/;
// jest uses the same bullet for config complaints as for failed tests
const TEST_RE = /^[^\S\n]*●[^\S\n]+(?!Console|Validation Warning|Deprecation Warning|Invalid testPattern)(.+?)[^\S\n]*$/;
const AT_RE = /^[^\S\n]+at .*?\(?([^\s()]+):(\d+):(\d+)\)?[^\S\n]*$/;

export default {
  name: "jest",
  category: "test",
  commands: ["jest"],
  detect: (s) => /^Tests:[^\S\n]+\d/m.test(s) || (/^[^\S\n]*●[^\S\n]+/m.test(s) && /^[^\S\n]*FAIL[^\S\n]+/m.test(s)),

  extract(s) {
    const lines = s.split("\n");
    const failures = [];
    let file = null;

    for (let i = 0; i < lines.length; i++) {
      const fm = lines[i].match(FILE_RE);
      if (fm) { file = fm[1].replace(/^\.\//, ""); continue; }
      const tm = lines[i].match(TEST_RE);
      if (!tm) continue;

      const body = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        if (TEST_RE.test(lines[j]) || FILE_RE.test(lines[j]) || /^Test Suites:/.test(lines[j])) break;
        body.push(lines[j]);
      }

      // first meaningful line is the matcher summary; keep Expected/Received too
      const msg = [];
      for (const l of body) {
        const t = l.trim();
        if (!t) continue;
        if (/^\d+[^\S\n]*\|/.test(t) || /^>[^\S\n]*\d+[^\S\n]*\|/.test(t) || /^\|/.test(t) || /^\^+$/.test(t)) continue;
        if (/^at /.test(t)) continue;
        // snapshot diffs open with a pair of count headers - "- Snapshot  - 3" and
        // "+ Received  + 3". Keeping those spends the budget before the actual diff.
        if (/^[-+][^\S\n]*(Snapshot|Received)[^\S\n]+[-+][^\S\n]*\d+[^\S\n]*$/.test(t)) continue;
        if (/^@@ [-+\d, ]+ @@$/.test(t)) continue;                   // diff hunk header
        // "Snapshot name: `<the test name> 1`" restates the title we already print
        if (/^Snapshot name:/.test(t)) continue;
        msg.push(t);
        if (msg.length >= 3) break;
      }

      // location: last "at ..." frame that points at a real file
      let loc = null;
      for (const l of body) {
        const am = l.match(AT_RE);
        if (am && !/node_modules|node:internal/.test(am[1])) loc = { file: am[1], line: +am[2], col: +am[3] };
      }

      if (!msg.length) continue;
      failures.push({
        file: loc?.file ?? file, line: loc?.line, col: loc?.col,
        title: tm[1], subject: tm[1], severity: "error", message: msg.join("\n"),
      });
      i = j - 1;
    }

    // When a suite throws before any test runs, jest's tally reads "Tests: 0 total" -
    // and a headline of "0 total" over a real failure reads as though nothing happened.
    // The suite tally is the one that says what went wrong in that case.
    const tests = s.match(/^Tests:[^\S\n]+(.+?)[^\S\n]*$/m);
    const suites = s.match(/^Test Suites:[^\S\n]+(.+?)[^\S\n]*$/m);
    const sm = /^0 total$/.test(tests?.[1] ?? "") && suites ? [null, `${suites[1]} (no tests ran)`] : tests;
    if (!failures.length) return null;
    return { tool: "jest", summary: sm?.[1], failures };
  },
};
