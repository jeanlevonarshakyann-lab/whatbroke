import { findJsonDocument, jsonDocumentsAt } from "../util.js";
import { joinSources, preserveSourceRange, withSource } from "../ownership.js";
// `deno lint` and `deno fmt --check` - deno's linter and formatter, as opposed to
// `deno test` and `deno check`, which have their own parsers. Nothing read either:
// `deno lint` came back from the generic reader holding one of its two findings, and in
// --compact and --json it came back with nothing at all.
//
// deno lint's default output is laid out exactly as rustc lays out a compile error:
//
//   error[no-explicit-any]: `any` type is not allowed
//    --> /app/orders.ts:1:14
//     |
//   1 | const order: any = "pending";
//     |              ^^^
//     = hint: Use a specific type other than `any`
//
// What tells the two apart is on the lines themselves. rustc's code is E and four digits
// and its file ends in .rs; a deno lint rule is a lowercase kebab-case name and its file
// is JavaScript or TypeScript. Both are required, on each finding.
const RULE = "[a-z][a-z0-9]*(?:-[a-z0-9]+)*";
const SCRIPT = /\.(?:[cm]?[jt]sx?)$/;
const HEAD_RE = new RegExp(`^error\\[(${RULE})\\]:[^\\S\\n]+(.+?)[^\\S\\n]*$`);
const AT_RE = /^[^\S\n]*-->[^\S\n]+(.+?):(\d+):(\d+)[^\S\n]*$/;
const SOURCE_RE = /^[^\S\n]*(\d+)[^\S\n]*\|[^\S\n]?(.*)$/;
const HINT_RE = /^[^\S\n]*=[^\S\n]*hint:[^\S\n]*(.+?)[^\S\n]*$/;
// --compact: `file:///app/orders.ts: line 1, col 14 - `any` type is not allowed (no-explicit-any)`
const COMPACT_RE = new RegExp(`^(.+?):[^\\S\\n]+line[^\\S\\n]+(\\d+),[^\\S\\n]+col[^\\S\\n]+(\\d+)[^\\S\\n]+-[^\\S\\n]+(.+?)[^\\S\\n]+\\((${RULE})\\)[^\\S\\n]*$`);
// --json: `{ "version": 1, "diagnostics": [...], "errors": [...] }`.
const REPORT = (v) => !!v && typeof v === "object" && Number.isInteger(v.version) &&
  Array.isArray(v.diagnostics) && v.diagnostics.length > 0 && v.diagnostics.every((d) =>
    d && typeof d.filename === "string" && typeof d.code === "string" &&
    Number.isInteger(d.range?.start?.line) && Number.isInteger(d.range?.start?.col));

const unfile = (p) => {
  if (!p.startsWith("file://")) return p;
  try { return decodeURIComponent(p.slice(7)); } catch { return p.slice(7); }
};

function pretty(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i].match(HEAD_RE);
    if (!head) continue;
    // The location is on the very next line. rustc guarantees that and so does deno;
    // a heading with anything else under it is not this shape.
    const at = lines[i + 1]?.match(AT_RE);
    if (!at || !SCRIPT.test(at[1])) continue;
    // The heading, its location, the source it quotes and the hint that closes it.
    let stmt, hint, end = i + 2;
    for (let j = i + 2; j < lines.length && !HEAD_RE.test(lines[j]); j++) {
      const source = lines[j].match(SOURCE_RE);
      if (source && +source[1] === +at[2] && stmt === undefined) { stmt = source[2].trim(); end = j + 1; }
      const h = lines[j].match(HINT_RE);
      if (h) { hint = h[1]; end = j + 1; break; }
    }
    out.push(withSource({
      file: unfile(at[1]), line: +at[2], col: +at[3], title: head[1], code: head[1],
      severity: "error", message: head[2], ...(hint ? { hint } : {}), ...(stmt ? { stmt } : {}),
    }, i, end));
  }
  return out;
}

function compact(lines) {
  const out = [];
  lines.forEach((line, i) => {
    const m = line.match(COMPACT_RE);
    if (!m || !SCRIPT.test(m[1])) return;
    out.push(withSource({ file: unfile(m[1]), line: +m[2], col: +m[3], title: m[5], code: m[5], severity: "error", message: m[4] }, i, i + 1));
  });
  return out;
}

function json(s, placed) {
  if (!s.includes('"diagnostics"')) return [];
  let doc = null, where = () => ({ start: 0, end: 1 });
  if (placed) { for (const found of jsonDocumentsAt(s, REPORT)) { ({ value: doc, where } = found); break; } }
  else doc = findJsonDocument(s, REPORT);
  return (doc?.diagnostics ?? []).filter((d) => SCRIPT.test(unfile(d.filename))).map((d) => {
    const { start, end } = where(d);
    return withSource({
      file: unfile(d.filename), line: d.range.start.line,
      // The document counts columns from zero; the other two formats of the same run count
      // from one. Read as given, one finding would be two findings a column apart.
      col: d.range.start.col + 1,
      title: d.code, code: d.code, severity: "error", message: String(d.message ?? "").trim(),
      ...(d.hint ? { hint: String(d.hint) } : {}),
    }, start, end);
  });
}

function findings(s, placed = false) {
  // Each form has a string it cannot be written without; a log holding none of them is
  // not split and scanned three times over.
  if (!s.includes("error[") && !s.includes(", col ") && !s.includes('"diagnostics"')) return [];
  const lines = s.split("\n");
  const out = [];
  const seen = new Map();
  for (const f of [...pretty(lines), ...compact(lines), ...json(s, placed)]) {
    const key = [f.file, f.line, f.col, f.code].join("|");
    // One run printed two ways is one finding, read in both places.
    if (seen.has(key)) { out[seen.get(key)] = joinSources(out[seen.get(key)], f); continue; }
    seen.set(key, out.length);
    out.push(f);
  }
  return out;
}

export default {
  name: "deno lint",
  // Strings a log has to hold for this parser to read anything from it - see src/router.js.
  signals: ["error[", ", col ", "\"diagnostics\""],
  category: "lint",
  commands: ["deno"],

  detect: (s) => findings(s).length > 0,

  extract(s) {
    const failures = findings(s, true).map((found) => {
      const { hint, ...f } = found;
      // The hint is what the rule would have you write instead, and it belongs with the
      // finding - the same way ruff's fix and pyright's reason do.
      return preserveSourceRange(found, { ...f, message: hint ? `${f.message}\n${hint}` : f.message });
    });
    if (!failures.length) return null;
    const n = failures.length;
    return { tool: "deno lint", summary: `${n} problem${n === 1 ? "" : "s"}`, failures };
  },
};

// `deno fmt --check` names each file it would rewrite and draws the change under it:
//
//   from /app/orders.ts:
//   3 | -console.log(order,quantity);
//   3 | +console.log(order, quantity);
//
//   error: Found 2 not formatted files in 2 files
//
// The tally is deno's own sentence, and a "from <file>:" heading only counts in a log
// that has it.
const FMT_TALLY_RE = /^error:[^\S\n]+Found[^\S\n]+(\d+)[^\S\n]+not formatted files?[^\S\n]+in[^\S\n]+\d+[^\S\n]+files?[^\S\n]*$/m;
const FMT_FILE_RE = /^from[^\S\n]+(.+?):[^\S\n]*$/;

export const denoFmt = {
  name: "deno fmt",
  // Strings a log has to hold for this parser to read anything from it - see src/router.js.
  signals: ["not formatted file"],
  category: "lint",
  commands: ["deno"],

  detect: (s) => FMT_TALLY_RE.test(s) && s.split("\n").some((l) => FMT_FILE_RE.test(l)),

  extract(s) {
    if (!FMT_TALLY_RE.test(s)) return null;
    const failures = [];
    const lines = s.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(FMT_FILE_RE);
      if (!m) continue;
      // The heading and the change drawn under it, to the blank line that ends it.
      let end = i + 1;
      while (end < lines.length && lines[end].trim() && !FMT_FILE_RE.test(lines[end]) && !FMT_TALLY_RE.test(lines[end])) end++;
      failures.push(withSource({
        file: unfile(m[1]), title: "not formatted", label: "not formatted", severity: "error",
        message: "this file is not formatted as deno fmt would write it",
      }, i, end));
    }
    if (!failures.length) return null;
    const n = failures.length;
    return { tool: "deno fmt", summary: `${n} file${n === 1 ? "" : "s"} failed the format check`, failures };
  },
};
