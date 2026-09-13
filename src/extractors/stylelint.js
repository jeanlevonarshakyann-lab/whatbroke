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
// --formatter compact: `/app/style.css: line 1, col 13, error - Expected ... (color-hex-length)`.
// eslint's compact formatter writes `Error` with a capital, and deno lint's writes no
// severity at all; stylelint's word is lower case.
const COMPACT_RE = /^(\S.*?):[^\S\n]+line[^\S\n]+(\d+),[^\S\n]+col[^\S\n]+(\d+),[^\S\n]+(error|warning)[^\S\n]+-[^\S\n]+(.+?)[^\S\n]*\(([\w-]+(?:\/[\w-]+)?)\)[^\S\n]*$/;
// --formatter tap: a `not ok` per file with a YAML block under it, keyed by rule, each
// problem a list item carrying its message, severity, line and column.
//
//   not ok 1 - /app/style.css
//     ---
//     color-hex-length:
//       - message: "Expected \"#FFF\" to be \"#FFFFFF\" (color-hex-length)"
//         severity: error
//         line: 1
//         column: 13
const TAP_FILE_RE = /^not ok[^\S\n]+\d+[^\S\n]+-[^\S\n]+(\S.*?)[^\S\n]*$/;
const TAP_RULE_RE = /^[^\S\n]{2}([\w-]+(?:\/[\w-]+)?):[^\S\n]*$/;
const TAP_MESSAGE_RE = /^[^\S\n]{4}-[^\S\n]+message:[^\S\n]+("(?:\\.|[^"\\])*")[^\S\n]*$/;
const TAP_FIELD_RE = /^[^\S\n]{6}(severity|line|column):[^\S\n]+(\S+)[^\S\n]*$/;
const TAP_END_RE = /^[^\S\n]{2}\.\.\.[^\S\n]*$/;
const TRAILING_RULE_RE = /[^\S\n]*\([\w-]+(?:\/[\w-]+)?\)[^\S\n]*$/;

/** The problems of a --formatter tap report. */
function tap(lines) {
  const out = [];
  let file = null, rule = null, current = null;
  const flush = () => { if (current) out.push(current); current = null; };
  for (const line of lines) {
    const f = line.match(TAP_FILE_RE);
    if (f) { flush(); file = f[1]; rule = null; continue; }
    if (!file) continue;
    if (TAP_END_RE.test(line)) { flush(); file = null; continue; }
    const r = line.match(TAP_RULE_RE);
    if (r) { flush(); rule = r[1]; continue; }
    const m = rule && line.match(TAP_MESSAGE_RE);
    if (m) {
      flush();
      let text;
      try { text = JSON.parse(m[1]); } catch { continue; }
      current = { file, rule, message: String(text).replace(TRAILING_RULE_RE, "") };
      continue;
    }
    const field = current && line.match(TAP_FIELD_RE);
    if (field) current[field[1]] = field[1] === "severity" ? field[2] : +field[2];
  }
  flush();
  // Every field has to be there: that is stylelint's block, and not a YAML block that
  // happens to use a word or two of the same vocabulary.
  return out.filter((p) => p.severity && Number.isInteger(p.line) && Number.isInteger(p.column));
}

// --formatter json: one record per file, the problems inside it.
const JSON_MARK = (v) => Array.isArray(v) && v.length > 0 &&
  v.every((r) => r && typeof r.source === "string" && Array.isArray(r.warnings));

export default {
  name: "stylelint",
  category: "lint",
  commands: ["stylelint"],

  detect: (s) => findJsonDocument(s, JSON_MARK) !== null ||
    s.split("\n").some((l) => UNIX_RE.test(l) || COMPACT_RE.test(l)) ||
    (/^not ok\b/m.test(s) && tap(s.split("\n")).length > 0) ||
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
    // The machine formats print no tally, and the counts they hold are the same ones the
    // table's tally states - so the summary is stylelint's own sentence either way.
    const warned = new Set();
    const warn = (file, line, col, rule) => warned.add(`${file}\u0000${line}\u0000${col}\u0000${rule}`);
    for (const line of s.split("\n")) {
      const u = line.match(UNIX_RE);
      if (u && u[6] === "error") {
        add({ file: u[1], line: +u[2], col: +u[3], title: u[5], code: u[5], severity: "error", message: u[4] });
      } else if (u) warn(u[1], u[2], u[3], u[5]);
    }
    for (const line of lines) {
      const c = line.match(COMPACT_RE);
      if (c && c[4] === "error") {
        add({ file: c[1], line: +c[2], col: +c[3], title: c[6], code: c[6], severity: "error", message: c[5] });
      } else if (c) warn(c[1], c[2], c[3], c[6]);
    }
    for (const p of /^not ok\b/m.test(s) ? tap(lines) : []) {
      if (p.severity !== "error") { warn(p.file, p.line, p.column, p.rule); continue; }
      add({ file: p.file, line: p.line, col: p.column, title: p.rule, code: p.rule, severity: "error", message: p.message });
    }
    for (const file of findJsonDocument(s, JSON_MARK) ?? []) {
      for (const w of file.warnings) {
        if (w.severity === "warning") { warn(file.source, w.line, w.column, w.rule); continue; }
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
    const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
    const hidden = summary ? warnings : warned.size;
    const e = failures.length;
    return {
      tool: "stylelint",
      summary: (summary ? summary[1]
        : `${plural(e + hidden, "problem")} (${plural(e, "error")}, ${plural(hidden, "warning")})`) +
        (hidden ? ` — ${plural(hidden, "warning")} hidden` : ""),
      failures,
    };
  },
};
