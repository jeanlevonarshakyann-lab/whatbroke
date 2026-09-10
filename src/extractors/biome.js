// Biome heads each finding with the location and the rule, then says what is wrong on
// the line under it, then draws the source and offers fixes:
//
//   biomebad.js:1:7 lint/correctness/noUnusedVariables  FIXABLE  ━━━━━━━━━━━━━
//
//     ! This variable x is unused.
//
//     > 1 │ const x = ;
//         │       ^
//
//     i Unused variables are often the result of typos ...
//     i Unsafe fix: If this is intentional, prepend x with an underscore.
//
// The "i" lines are advice and the diff under them is the fix; neither is the diagnosis.
// The rule is the last field of the header and is what you would disable.
const HEAD_RE = /^(\S+?):(\d+):(\d+)[^\S\n]+(\S+?)(?:[^\S\n]+(?:FIXABLE|INFO|WARNING|ERROR|PARSE))*[^\S\n]*━*[^\S\n]*$/;
// "  ! This variable x is unused." - the severity glyph, then the message.
const MESSAGE_RE = /^[^\S\n]*([!×✖⚠])[^\S\n]+(\S.*?)[^\S\n]*$/;
// "  > 1 │ const x = ;" - the marked line of the source frame.
const MARKED_RE = /^[^\S\n]*>[^\S\n]*(\d+)[^\S\n]*│[^\S\n]?(.*)$/;
const TALLY_RE = /^(?:Checked|Found) \d+|^[^\S\n]*\d+ error[s]? found/m;

export default {
  name: "biome",
  category: "lint",
  commands: ["biome"],

  detect: (s) => s.split("\n").some((l) => HEAD_RE.test(l) && /\//.test(l.split(/\s+/)[1] ?? "")),

  extract(s) {
    const lines = s.split("\n");
    const failures = [];
    for (let i = 0; i < lines.length; i++) {
      const h = lines[i].match(HEAD_RE);
      if (!h) continue;
      // The rule is a path like "lint/correctness/noUnusedVariables"; without one this
      // header is some other tool's "file:line:col something".
      if (!h[4].includes("/")) continue;

      let message = "", stmt;
      for (let j = i + 1; j < lines.length && j <= i + 8; j++) {
        if (HEAD_RE.test(lines[j]) && (lines[j].split(/\s+/)[1] ?? "").includes("/")) break;
        const m = lines[j].match(MESSAGE_RE);
        if (m && !message) { message = m[2]; continue; }
        const marked = lines[j].match(MARKED_RE);
        if (marked && !stmt) { stmt = marked[2].trim(); }
      }

      failures.push({
        file: h[1], line: +h[2], col: +h[3],
        title: h[4], code: h[4], severity: "error",
        message: message || h[4], stmt,
      });
    }
    if (!failures.length) return null;
    const n = failures.length;
    return { tool: "biome", summary: `${n} problem${n === 1 ? "" : "s"}`, failures };
  },
};
