import { colonPlaces, elements, findJsonDocument, jsonDocumentsAt, lineAt, tailFirst, xmlAttributes } from "../util.js";
import { joinSources, preserveSourceRange, withSource } from "../ownership.js";
// shellcheck writes two formats a CI job is likely to produce, and neither was read.
// Its default is a block per location:
//
//   In deploy.sh line 4:
//   for f in $(ls *.txt); do
//            ^---------^ SC2045 (error): Iterating over ls output is fragile. Use globs.
//                 ^-- SC2035 (info): Use ./*glob* or -- *glob* so names with dashes...
//
// Nothing in that carries a file:line on the same line as the message, so the whole run
// came back "could not identify a diagnostic". Under `-f gcc` it becomes one line per
// finding and the generic fallback scraped it, counting shellcheck's notes as errors.
//
// The block header is what bounds this parser: a caret line is only read while a header
// is open, so it can never be attached to a location from somewhere else in the log, and
// the "Did you mean:" suggestion and the wiki links at the end are not read at all.
const HEADER = /^In[^\S\n]+(.+?)[^\S\n]+line[^\S\n]+(\d+):[^\S\n]*$/;
// The carets are drawn under the offending span, so where they start is the column -
// which is the same number `-f gcc` prints. `^--` and `^----^` are both spans.
const CARET = /^([^\S\n]*)\^[-^]*[^\S\n]+(SC\d+)[^\S\n]+\((error|warning|info|style)\):[^\S\n]+(.+?)[^\S\n]*$/;
// `deploy.sh:4:10: error: Iterating over ls output is fragile. Use globs. [SC2045]`.
// The trailing code is what makes the line shellcheck's rather than any compiler's.
// `-f gcc`: `file:line:col: severity: message [SCnnnn]` - the pattern
//   /^(.+?):(\d+):(\d+):[^\S\n]+(error|warning|note):[^\S\n]+(.+?)[^\S\n]+\[(SC\d+)\][^\S\n]*$/
// matched without reading a long line again from every colon in it.
export const gccLine = (line) => tailFirst(line, {
  tail: /\[(SC\d+)\][^\S\n]*$/, spaceBefore: 1, emptyMessage: false,
  heads: (l, c, clear) => colonPlaces(l, 0, c, /:(\d+):(\d+):[^\S\n]+(error|warning|note):/y, (p) => clear(0, p)),
});

// And three machine formats, none of which was read. `-f json` is a bare array of the
// findings; `-f json1` is the same array inside an object, which is the difference
// between them; `-f checkstyle` is an XML document.
//
// The code is a NUMBER in the JSON forms and `ShellCheck.SC2086` in the checkstyle one,
// where the text forms print `SC2086`. Both are turned back into what shellcheck calls
// the check everywhere else, so one run printed two ways is one finding and not two.
const COMMENT = (c) => c && typeof c.file === "string" && Number.isInteger(c.line) &&
  Number.isInteger(c.code) && typeof c.level === "string" && typeof c.message === "string";
const JSON_MARK = (v) => {
  const list = Array.isArray(v) ? v : Array.isArray(v?.comments) ? v.comments : null;
  return !!list && list.length > 0 && list.every(COMMENT);
};
const comments = (s) => {
  if (!s.includes('"level"')) return [];
  const v = findJsonDocument(s, JSON_MARK);
  return v === null ? [] : Array.isArray(v) ? v : v.comments;
};
// checkstyle is a shape other linters write too, so what makes it shellcheck's is the
// source attribute: every finding declares `ShellCheck.SC####` as the check that made it.
const CHECKSTYLE_FILE = /<file\b([^>]*)>([\s\S]*?)<\/file>/dg;
const CHECKSTYLE_ERROR = /<error\b([^>]*?)\/?>/g;
const CHECKSTYLE_FILE_ELEMENT = { open: /<file\b/, close: () => "</file>" };
const SHELLCHECK_SOURCE = /^ShellCheck\.(SC\d+)$/;

/** The findings of a run in one of the three machine formats - each with the lines it was
 *  read from when `placed`, which deciding whether to claim a log does not need. */
function machine(s, placed = false) {
  const out = [];
  const at = (f, start, end) => (placed ? withSource(f, start, end) : f);
  if (placed) {
    for (const { value, where } of s.includes('"level"') ? jsonDocumentsAt(s, JSON_MARK) : []) {
      for (const c of Array.isArray(value) ? value : value.comments) {
        const { start, end } = where(c);
        out.push(at({ file: c.file, line: c.line, col: c.column, code: `SC${c.code}`,
          severity: c.level, message: String(c.message).trim() }, start, end));
      }
      break;
    }
  } else {
    for (const c of comments(s)) {
      out.push({ file: c.file, line: c.line, col: c.column, code: `SC${c.code}`,
        severity: c.level, message: String(c.message).trim() });
    }
  }
  if (s.includes("ShellCheck.SC")) {
    for (const doc of elements(s, CHECKSTYLE_FILE, CHECKSTYLE_FILE_ELEMENT)) {
      const file = xmlAttributes(doc[1]).name;
      for (const err of doc[2].matchAll(CHECKSTYLE_ERROR)) {
        const a = xmlAttributes(err[1]);
        const source = SHELLCHECK_SOURCE.exec(a.source ?? "");
        if (!source || !file) continue;
        const offset = doc.indices[2][0] + err.index;
        out.push(at({ file, line: +a.line, col: +a.column, code: source[1],
          severity: a.severity, message: String(a.message ?? "").trim() },
        lineAt(s, offset), lineAt(s, offset + err[0].length - 1) + 1));
      }
    }
  }
  return out;
}

export default {
  name: "shellcheck",
  category: "lint",
  commands: ["shellcheck"],

  detect: (s) => HEADER.test(s.split("\n").find((l) => HEADER.test(l)) ?? "") ||
    s.split("\n").some((l) => gccLine(l)) ||
    machine(s).length > 0,

  extract(s) {
    const lines = s.split("\n");
    let found = [];
    let file = null, line = null, stmt = null, header = -1;
    for (let i = 0; i < lines.length; i++) {
      const g = gccLine(lines[i]);
      if (g) {
        found.push(withSource({ file: g[1], line: +g[2], col: +g[3], code: g[6], severity: g[4], message: g[5] }, i, i + 1));
        continue;
      }
      const h = lines[i].match(HEADER);
      if (h) {
        file = h[1]; line = +h[2]; header = i;
        // The line under the header is the source shellcheck is pointing at. It is the
        // one thing here worth quoting back, and it is quoted from the log verbatim.
        stmt = lines[i + 1]?.trim() || null;
        continue;
      }
      // The block's header, the source under it, and the caret line naming this finding.
      const c = file && lines[i].match(CARET);
      if (c) found.push(withSource({ file, line, col: c[1].length + 1, code: c[2], severity: c[3], message: c[4], stmt }, header, i + 1));
    }
    found.push(...machine(s, true));
    if (!found.length) return null;
    // A log can hold both formats - two shellcheck runs, or one job rendering twice - and
    // the same finding then arrives once per format. They are not two problems. The code
    // is what separates them from a genuine pair at one position: lib.sh:2:8 really does
    // carry both SC2006 and SC2116. The block format is kept over `-f gcc` where they
    // collide, because only it quotes the offending source line.
    const seen = new Map();
    for (const f of found) {
      const key = `${f.file}\u0000${f.line}\u0000${f.col}\u0000${f.code}`;
      const kept = seen.get(key);
      // Either way, the finding keeps both places it was read.
      if (!kept) seen.set(key, f);
      else if (f.stmt && !kept.stmt) seen.set(key, joinSources(f, kept));
      else seen.set(key, joinSources(kept, f));
    }
    found = [...seen.values()];
    // shellcheck ranks its findings error > warning > info > style, and exits non-zero on
    // any of them: a run that fails purely on one SC2086 (info) is the common case, not
    // the exception. So when there are no errors the rest are not noise to be hidden -
    // they are the entire reason the command failed, and the summary says which kind
    // they were rather than calling them errors. Where errors do exist they are what
    // blocked the run and the lower severities are set aside behind them.
    //
    // severity here means "this is what stopped you", not the word shellcheck printed;
    // prettier resolves its own [warn] the same way, and a failure marked "warning" is
    // a contradiction the suite rejects outright.
    const errors = found.filter((f) => f.severity === "error");
    const shown = errors.length ? errors : found;
    const hidden = found.length - shown.length;
    const kinds = [...new Set(shown.map((f) => f.severity))];
    return {
      tool: "shellcheck",
      // "3 style findings" describes the findings and not the outcome, and a headline
      // that does not admit the run failed is the one mistake the guarantees suite
      // exists to catch - prettier's "needs formatting" was the same error.
      summary: (errors.length
        ? `${errors.length} error${errors.length > 1 ? "s" : ""}`
        : `failed on ${shown.length} ${kinds.join("/")} finding${shown.length > 1 ? "s" : ""}`) +
        (hidden ? ` — ${hidden} lower-severity finding${hidden > 1 ? "s" : ""} hidden` : ""),
      failures: shown.map((f) => preserveSourceRange(f, {
        file: f.file, line: f.line, col: f.col, title: f.code, code: f.code,
        severity: "error", message: f.message, ...(f.stmt ? { stmt: f.stmt } : {}),
      })),
    };
  },
};
