// stylelint reports like eslint - the file on its own line, the problems indented under
// it - but marks severity with a glyph rather than a word:
//
//   style.css
//     1:8   ✖  Unknown property "colr"     property-no-unknown
//     4:6   ⚠  Duplicate property "color"  declaration-block-no-duplicate-properties
//
//   ✖ 4 problems (3 errors, 1 warning)
//
// The rule name is the last field and is what you would disable or search for, so it is
// the code; the message is what is left once it is taken off the end.
const PROBLEM_RE = /^[^\S\n]+(\d+):(\d+)[^\S\n]+([✖⚠ⓘ])[^\S\n]+(.+?)[^\S\n]{2,}([\w-]+(?:\/[\w-]+)?)[^\S\n]*$/;
const SUMMARY_RE = /^[^\S\n]*[✖⚠][^\S\n]+(\d+ problems? \(.+?\))[^\S\n]*$/m;
// A file is named on its own line, unindented, with no colon or glyph of its own.
const FILE_RE = /^(?![^\S\n])(\S.*?)[^\S\n]*$/;
const NOISE_RE = /potentially fixable|^\s*$/;

export default {
  name: "stylelint",
  category: "lint",
  commands: ["stylelint"],

  detect: (s) => SUMMARY_RE.test(s) ||
    s.split("\n").some((l) => PROBLEM_RE.test(l)),

  extract(s) {
    const lines = s.split("\n");
    const failures = [];
    let file = null;
    let warnings = 0;

    for (const line of lines) {
      const p = line.match(PROBLEM_RE);
      if (p) {
        // ⚠ is a warning and ⓘ is a note; neither failed the run
        if (p[3] !== "✖") { warnings++; continue; }
        failures.push({
          file: file ?? undefined, line: +p[1], col: +p[2],
          title: p[5], code: p[5], severity: "error",
          message: p[4].trim(),
        });
        continue;
      }
      if (NOISE_RE.test(line) || SUMMARY_RE.test(line)) continue;
      const f = line.match(FILE_RE);
      if (f && !/^[✖⚠ⓘ]/.test(f[1])) file = f[1];
    }

    if (!failures.length) return null;
    const summary = s.match(SUMMARY_RE);
    return {
      tool: "stylelint",
      summary: summary
        ? `${summary[1]}${warnings ? ` — ${warnings} warning${warnings > 1 ? "s" : ""} hidden` : ""}`
        : `${failures.length} problem${failures.length === 1 ? "" : "s"}`,
      failures,
    };
  },
};
