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
//
// As with pylint, the filename can hold a space - `my project/src/app.js:1:11 parse ━━━`
// - and (\S+?) matched none of it. The rule name and the rule line that follow are what
// bound it; the name itself is not a shape worth insisting on.
//
// Not every section is a lint rule, and requiring one lost the errors. `parse` heads a
// file biome could not read at all, and `format` heads one whose formatting differs -
// which under `biome format` is the only finding there is. Both were dropped, so a log
// reading "Found 2 errors. Found 1 warning." came back as the one warning.
const HEAD_RE = /^(.+?):(\d+):(\d+)[^\S\n]+(\S+?)(?:[^\S\n]+(?:FIXABLE|INFO|WARNING|ERROR|PARSE))*[^\S\n]*━*[^\S\n]*$/;
// `my project/src/fmt.js format ━━━` - biome's file-level sections carry no line or
// column. The run's closing banner is `format ━━━` or `check ━━━`, the command's own
// name with nothing in front of it - until a monorepo runner prefixes every line, and
// then `api:lint: check ━━━` has something in front of it and was read as a file called
// `api:lint:`. Nothing before the category is not the test. Being a filename is, and a
// filename here ends in an extension.
const FILE_HEAD_RE = /^(\S.*?\.\w+)[^\S\n]+(parse|format|organizeImports|assist)[^\S\n]*━+[^\S\n]*$/;
// Said once the real diagnosis has already been printed above it.
const RESTATEMENT = /^(?:Code formatting aborted due to parsing errors|Some errors were emitted)/;
// "  ! This variable x is unused." - the severity glyph, then the message.
const MESSAGE_RE = /^[^\S\n]*([!×✖⚠])[^\S\n]+(\S.*?)[^\S\n]*$/;
// "  > 1 │ const x = ;" - the marked line of the source frame.
const MARKED_RE = /^[^\S\n]*>[^\S\n]*(\d+)[^\S\n]*│[^\S\n]?(.*)$/;
const TALLY_RE = /^(?:Checked|Found) \d+|^[^\S\n]*\d+ error[s]? found/m;

/** A section header, or null. Biome heads a finding either with a location and a rule or
 *  - for a whole file it could not parse or format - with just the file and the section
 *  name. A rule is a path; `parse` and `format` are biome's own and are neither. */
function header(line) {
  const h = line.match(HEAD_RE);
  if (h) {
    if (prefixed(h[1])) return null;
    if (!h[4].includes("/") && !/^(?:parse|format|organizeImports|assist)$/.test(h[4])) return null;
    return { file: h[1], line: +h[2], col: +h[3], title: h[4], code: h[4] };
  }
  const f = line.match(FILE_HEAD_RE);
  if (f && !prefixed(f[1])) return { file: f[1], title: f[2], code: f[2] };
  return null;
}

/** Letting the name hold a space also let it hold a monorepo runner's prefix, and biome
 *  read `api:lint: biomebad.js` as a file - swallowing the wrapper, so the stripped log
 *  no longer looked like the better parse and normalization stopped happening. A path
 *  segment can contain a space; `api:lint: ` is a colon with whitespace after it, which
 *  is what every runner writes and what no path does. `C:\src` is untouched: the colon
 *  there is followed by a separator, not a space. */
function prefixed(name) {
  return /:[^\S\n]/.test(name);
}

export default {
  name: "biome",
  category: "lint",
  commands: ["biome"],

  detect: (s) => s.split("\n").some((l) => header(l) !== null),

  extract(s) {
    const lines = s.split("\n");
    const found = [];
    for (let i = 0; i < lines.length; i++) {
      const h = header(lines[i]);
      if (!h) continue;

      let message = "", marker = "", stmt;
      for (let j = i + 1; j < lines.length && j <= i + 8; j++) {
        if (header(lines[j])) break;
        const m = lines[j].match(MESSAGE_RE);
        if (m && !message) { marker = m[1]; message = m[2]; continue; }
        const marked = lines[j].match(MARKED_RE);
        if (marked && !stmt) { stmt = marked[2].trim(); }
      }
      // Biome says which it is with the glyph it draws: × and ✖ for what failed, ! and
      // ⚠ for what it merely disliked. It always draws one, so a section without one is
      // a section this did not actually read - which is what a monorepo runner's prefix
      // produces, and defaulting those to "error" made a wrapped log parse to MORE than
      // the same log clean, so the strip stopped looking like an improvement and stopped
      // being applied.
      if (!marker) continue;
      if (RESTATEMENT.test(message)) continue;
      found.push({
        ...h, severity: marker === "!" || marker === "\u26a0" ? "warning" : "error",
        message: message || h.code, stmt,
      });
    }
    if (!found.length) return null;
    // The house rule everywhere else here: an error is what failed the run, and warnings
    // stand behind it - unless they are all there is, and then they are the reason.
    const errors = found.filter((f) => f.severity === "error");
    const shown = (errors.length ? errors : found).map((f) => ({ ...f, severity: "error" }));
    const hidden = found.length - shown.length;
    const n = shown.length;
    return {
      tool: "biome",
      summary: `${n} ${errors.length ? "error" : "warning"}${n === 1 ? "" : "s"}` +
        (hidden ? ` — ${hidden} warning${hidden > 1 ? "s" : ""} hidden` : ""),
      failures: shown,
    };
  },
};
