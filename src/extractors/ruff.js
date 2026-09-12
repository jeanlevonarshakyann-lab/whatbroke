// ruff emits rustc-style diagnostics: a header line, then " --> file:line:col".
const HEAD_RE = /^([A-Z]+\d+)(?:[^\S\n]+\[[*x]\])?[^\S\n]+(.+)$/;
// Not everything ruff reports has a rule code. A file it cannot parse is reported as
// `invalid-syntax: unexpected EOF while parsing`, and requiring a code meant a run that
// said "Found 1 error." came back with none at all - which is the ordinary case of
// running ruff over a file with a typo in it.
// Bare error:/help: also precede arrows in other tools; they are not Ruff rules.
const BARE_HEAD_RE = /^(invalid-syntax):[^\S\n]+(.+)$/;
const ARROW_RE = /^[^\S\n]*-->[^\S\n]+(.+?):(\d+):(\d+)[^\S\n]*$/;

// --output-format is a flag, and only the default was read. The rest either said nothing
// at all or - worse - were claimed by flake8, whose `file:line:col: CODE message` is
// exactly ruff's concise form. What separates them is what ruff says about ITSELF: the
// "Found N errors." tally, the "[*] N fixable" note, and the `title=ruff` it stamps on a
// GitHub annotation. flake8 writes none of those.
// "Found N errors." is NOT one of them, however much it looks like one: biome prints
// exactly that line, and with it in here ruff claimed pylint's findings out of any log
// that also held a biome run - 24 ordered pairs, caught by test/mixed.js. What is left
// is genuinely ruff's alone.
const RUFF_SAYS_SO = /^\[\*\][^\S\n]+\d+[^\S\n]+fixable|title=ruff[^\S\n]*\(/m;
// `lint_me.py:1:8: F401 [*] \`os\` imported but unused` - the [*] marks it fixable, which
// is ruff talking about its own options rather than about your code.
// pylint writes the very same line with a colon after the code - "E0602: Undefined
// variable" - and without excluding that, a log holding both reported pylint's findings
// as ruff's on top of pylint's own.
// The lookahead has to refuse a digit as well as the colon. Refusing only the colon let
// the code match a PREFIX of pylint's - "C011" out of "C0114:" - and the guard then
// looked at the "4" and was satisfied.
const CONCISE_RE = /^(.+?):(\d+):(\d+):[^\S\n]+([A-Z]+\d+|invalid-syntax)(?![\w:])[^\S\n]*(?:\[[*x]\][^\S\n]*)?(.*)$/;
// --output-format=grouped puts the file on its own line and indents the rest.
const GROUP_FILE_RE = /^(\S.*?):[^\S\n]*$/;
const GROUP_ENTRY_RE = /^[^\S\n]+(\d+):(\d+)[^\S\n]+([A-Z]+\d+|invalid-syntax)(?![\w:])[^\S\n]*(?:\[[*x]\][^\S\n]*)?(.*)$/;
// --output-format=github, the one a GitHub Actions job uses so the findings annotate the
// diff. The message is percent-encoded because a workflow command may not span lines.
const GITHUB_RE = /^::(?:error|warning)[^\S\n]+title=ruff[^\S\n]*\(([^)]+)\),file=(.+?),line=(\d+),col=(\d+)[^:]*::(.*)$/;

/** ruff's concise, grouped and GitHub forms - one line per finding, no `-->` beneath. */
function oneLinePerFinding(lines) {
  const failures = [];
  let group = null;
  for (const line of lines) {
    const gh = line.match(GITHUB_RE);
    if (gh) {
      // "%0A  help: Remove unused import" - the fix advice, on its own line once decoded.
      const text = gh[5].replace(/%0A/g, "\n").replace(/%25/g, "%").split("\n");
      const head = text[0].replace(/^.*?:\d+:\d+:[^\S\n]+[A-Z]+\d+[^\S\n]*/, "").trim();
      const help = text.slice(1).map((l) => l.replace(/^[^\S\n]*help:[^\S\n]*/, "").trim()).filter(Boolean);
      failures.push({
        file: gh[2], line: +gh[3], col: +gh[4],
        title: gh[1], code: gh[1], severity: "error",
        message: [head, ...help].filter(Boolean).join("\n"),
      });
      continue;
    }
    const c = line.match(CONCISE_RE);
    if (c) {
      failures.push({
        file: c[1], line: +c[2], col: +c[3],
        title: c[4], code: c[4], severity: "error", message: c[5].trim(),
      });
      continue;
    }
    const g = group && line.match(GROUP_ENTRY_RE);
    if (g) {
      failures.push({
        file: group, line: +g[1], col: +g[2],
        title: g[3], code: g[3], severity: "error", message: g[4].trim(),
      });
      continue;
    }
    const f = line.match(GROUP_FILE_RE);
    if (f && !/^Found |^\[\*\]/.test(line)) group = f[1];
  }
  return failures;
}

/** --output-format=json: an array of records, pretty-printed across many lines.
 *
 *  Every array that opens a line is a candidate, and the first one whose records carry
 *  ruff's fields wins. Starting from the first `[` in the log was the obvious way and a
 *  wrong one: in a log holding another tool's JSON as well, the scan opened on somebody
 *  else's bracket and swallowed the rest - 148 ordered pairs lost failures that way. */
function jsonFindings(text) {
  if (!text.includes('"filename"') || !text.includes('"code"')) return [];
  for (const open of text.matchAll(/^[^\S\n]*\[/gm)) {
    const found = arrayAt(text, open.index + open[0].length - 1);
    if (found.length) return found;
  }
  return [];
}

/** Whitespace outside the strings is rewritten to a plain space on the way past: JSON
 *  admits only space, tab, CR and LF between tokens, and a runner that re-indents what
 *  it relays - pnpm uses U+2009 THIN SPACE - otherwise leaves a report that will not
 *  parse at all. Inside a string the same character is data and is kept. */
function arrayAt(text, start) {
  let depth = 0, inString = false, escaped = false;
  const out = [];
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out.push(c);
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    out.push(/\s/.test(c) && !"\t\n\r ".includes(c) ? " " : c);
    if (c === '"') { inString = true; continue; }
    if (c === "[") depth++;
    else if (c === "]" && --depth === 0) {
      let parsed;
      try { parsed = JSON.parse(out.join("")); } catch { return []; }
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((r) => r && typeof r.filename === "string" && r.location)
        .map((r) => ({
          file: r.filename, line: r.location.row, col: r.location.column,
          title: r.code ?? "ruff", ...(r.code ? { code: r.code } : { label: "ruff" }),
          severity: "error",
          message: [r.message, r.fix?.message].filter(Boolean).join("\n"),
        }));
    }
  }
  return [];
}

export default {
  name: "ruff",
  category: "lint",
  commands: ["ruff"],
  detect: (s) => (/^Found \d+ errors?\.?$/m.test(s) && /^[^\S\n]*-->\s/m.test(s)) ||
    (RUFF_SAYS_SO.test(s) && oneLinePerFinding(s.split("\n")).length > 0) ||
    jsonFindings(s).length > 0,

  extract(s) {
    const lines = s.split("\n");
    // A header is only a header if a location follows it. ruff writes `help:` at column
    // zero too, so the shape alone cannot tell a diagnostic from its own continuation.
    const headerAt = (i) =>
      (ARROW_RE.test(lines[i + 1] ?? "") ? (lines[i].match(HEAD_RE) ?? lines[i].match(BARE_HEAD_RE)) : null);
    const failures = [];
    for (let i = 0; i < lines.length; i++) {
      const h = headerAt(i);
      if (!h) continue;
      const a = lines[i + 1].match(ARROW_RE);
      let fix = "";
      for (let j = i + 2; j < lines.length && !headerAt(j); j++) {
        if (!lines[j].trim() || /^Found \d+ errors?\.?$/.test(lines[j])) break;
        const f = lines[j].match(/^[^\S\n]*help:[^\S\n]*(.+)$/);
        if (f) { fix = f[1]; break; }
      }
      failures.push({
        file: a[1], line: +a[2], col: +a[3],
        title: h[1], code: h[1], severity: "error", message: [h[2], fix].filter(Boolean).join("\n"),
      });
      i++;
    }
    // The other formats are read whatever the default form gave, because one log can
    // hold two ruff runs - `ruff check a; ruff check --output-format=json b` - and
    // reading only the first left the second run's findings out without a word. A
    // finding already reported is not added twice.
    const seen = new Set(failures.map((f) => `${f.file}\u0000${f.line}\u0000${f.col}\u0000${f.code}`));
    for (const f of [...jsonFindings(s), ...(RUFF_SAYS_SO.test(s) ? oneLinePerFinding(lines) : [])]) {
      const key = `${f.file}\u0000${f.line}\u0000${f.col}\u0000${f.code}`;
      if (seen.has(key)) continue;
      seen.add(key);
      failures.push(f);
    }
    if (!failures.length) return null;
    const sm = s.match(/^Found (\d+) errors?\.?$/m);
    const n = Number(sm ? sm[1] : failures.length);
    return { tool: "ruff", summary: `${n} error${n === 1 ? "" : "s"}`, failures };
  },
};
