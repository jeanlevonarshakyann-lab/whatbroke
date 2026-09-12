import { findJsonDocument } from "../util.js";
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
// --formatter unix: one line per problem, the rule in brackets at the end of the text
// and the severity after it. The fallback scraped these and left the rule inside the
// message, with no code to group on and no tool name.
const UNIX_RE = /^(\S.*?):(\d+):(\d+):[^\S\n]+(.+?)[^\S\n]*\(([\w-]+(?:\/[\w-]+)?)\)[^\S\n]*\[(error|warning)\][^\S\n]*$/;
// --formatter json: one record per file, the problems inside it.
const JSON_MARK = (v) => Array.isArray(v) && v.length > 0 &&
  v.every((r) => r && typeof r.source === "string" && Array.isArray(r.warnings));

export default {
  name: "stylelint",
  category: "lint",
  commands: ["stylelint"],

  detect: (s) => findJsonDocument(s, JSON_MARK) !== null ||
    s.split("\n").some((l) => UNIX_RE.test(l)) ||
    SUMMARY_RE.test(s) ||
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

    // The machine formats, read whatever the table gave: one log can hold two runs.
    const already = new Set(failures.map((f) => `${f.file}\u0000${f.line}\u0000${f.col}\u0000${f.code}`));
    const add = (f) => {
      const key = `${f.file}\u0000${f.line}\u0000${f.col}\u0000${f.code}`;
      if (already.has(key)) return;
      already.add(key);
      failures.push(f);
    };
    for (const line of s.split("\n")) {
      const u = line.match(UNIX_RE);
      if (u && u[6] === "error") {
        add({ file: u[1], line: +u[2], col: +u[3], title: u[5], code: u[5], severity: "error", message: u[4] });
      }
    }
    for (const file of findJsonDocument(s, JSON_MARK) ?? []) {
      for (const w of file.warnings) {
        if (w.severity === "warning") continue;
        add({
          file: file.source, line: w.line, col: w.column,
          title: w.rule, code: w.rule, severity: "error",
          // stylelint repeats the rule in brackets at the end of its own text.
          message: String(w.text ?? "").replace(/[^\S\n]*\([\w-]+(?:\/[\w-]+)?\)[^\S\n]*$/, ""),
        });
      }
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
