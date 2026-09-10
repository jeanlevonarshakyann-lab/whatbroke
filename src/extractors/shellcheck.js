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
const GCC = /^(.+?):(\d+):(\d+):[^\S\n]+(error|warning|note):[^\S\n]+(.+?)[^\S\n]+\[(SC\d+)\][^\S\n]*$/;

export default {
  name: "shellcheck",
  category: "lint",
  commands: ["shellcheck"],

  detect: (s) => HEADER.test(s.split("\n").find((l) => HEADER.test(l)) ?? "") ||
    GCC.test(s.split("\n").find((l) => GCC.test(l)) ?? ""),

  extract(s) {
    const lines = s.split("\n");
    let found = [];
    let file = null, line = null, stmt = null;
    for (let i = 0; i < lines.length; i++) {
      const g = lines[i].match(GCC);
      if (g) {
        found.push({ file: g[1], line: +g[2], col: +g[3], code: g[6], severity: g[4], message: g[5] });
        continue;
      }
      const h = lines[i].match(HEADER);
      if (h) {
        file = h[1]; line = +h[2];
        // The line under the header is the source shellcheck is pointing at. It is the
        // one thing here worth quoting back, and it is quoted from the log verbatim.
        stmt = lines[i + 1]?.trim() || null;
        continue;
      }
      const c = file && lines[i].match(CARET);
      if (c) found.push({ file, line, col: c[1].length + 1, code: c[2], severity: c[3], message: c[4], stmt });
    }
    if (!found.length) return null;
    // A log can hold both formats - two shellcheck runs, or one job rendering twice - and
    // the same finding then arrives once per format. They are not two problems. The code
    // is what separates them from a genuine pair at one position: lib.sh:2:8 really does
    // carry both SC2006 and SC2116. The block format is kept over `-f gcc` where they
    // collide, because only it quotes the offending source line.
    const seen = new Map();
    for (const f of found) {
      const key = `${f.file}\u0000${f.line}\u0000${f.col}\u0000${f.code}`;
      if (!seen.has(key) || (f.stmt && !seen.get(key).stmt)) seen.set(key, f);
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
      failures: shown.map((f) => ({
        file: f.file, line: f.line, col: f.col, title: f.code, code: f.code,
        severity: "error", message: f.message, ...(f.stmt ? { stmt: f.stmt } : {}),
      })),
    };
  },
};
