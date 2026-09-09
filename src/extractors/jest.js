// With multiple jest projects the display name comes first: "FAIL jsdom src/a.js".
// Take the last token, which is always the path.
const FILE_RE = /^[ \t]*(?:FAIL|PASS)[ \t]+(?:\S+[ \t]+)*?(\S+)[ \t]*$/;
// jest uses the same bullet for config complaints as for failed tests
const TEST_RE = /^[ \t]*●[ \t]+(?!Console|Validation Warning|Deprecation Warning|Invalid testPattern)(.+?)[ \t]*$/;
const AT_RE = /^[ \t]+at .*?\(?([^\s()]+):(\d+):(\d+)\)?[ \t]*$/;

export default {
  name: "jest",
  detect: (s) => /^Tests:[ \t]+\d/m.test(s) || (/^[ \t]*●[ \t]+/m.test(s) && /^[ \t]*FAIL[ \t]+/m.test(s)),

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
        if (/^\d+[ \t]*\|/.test(t) || /^>[ \t]*\d+[ \t]*\|/.test(t) || /^\|/.test(t) || /^\^+$/.test(t)) continue;
        if (/^at /.test(t)) continue;
        // snapshot diffs open with a pair of count headers - "- Snapshot  - 3" and
        // "+ Received  + 3". Keeping those spends the budget before the actual diff.
        if (/^[-+][ \t]*(Snapshot|Received)[ \t]+[-+][ \t]*\d+[ \t]*$/.test(t)) continue;
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

    const sm = s.match(/^Tests:[ \t]+(.+?)[ \t]*$/m);
    if (!failures.length) return null;
    return { tool: "jest", summary: sm?.[1], failures };
  },
};
