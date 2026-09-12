// CSI covers colours plus cursor/erase controls; OSC covers terminal hyperlinks and
// window-title commands, terminated by BEL or ST. Both have seven- and eight-bit
// encodings. Keeping this local avoids a runtime dependency while handling the control
// families emitted by modern terminals and clickable CI log viewers.
export const ANSI = /(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]|(?:\x1b\]|\x9d)[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)/g;
// Cursor-up/down commands are not decoration. A rich progress renderer can interrupt
// a diagnostic halfway through its filename, redraw two status lines, then resume the
// filename where the terminal cursor returned. Simply deleting the controls glues all
// of that into one plausible-looking diagnostic. A physical line that moves between
// terminal rows is transient screen state, so it cannot safely support a diagnosis.
const VERTICAL_REDRAW = /(?:\x1b\[|\x9b)[0-?]*[ -/]*[ABEF]/;
export const stripAnsi = (s) => {
  if (!VERTICAL_REDRAW.test(s)) return s.replace(ANSI, "");
  // Keep the separators byte-for-byte. In a collected redraw blob, bare CR separates
  // logical rows but the outer CI prefix exists only once, at the physical line's head;
  // normalising CR here would make that vetted prefix look non-uniform before the
  // dedicated pre-redraw stripping pass can see it.
  return s.split(/(\r\n|\r|\n)/)
    .map((part, index) => index % 2 === 0 && VERTICAL_REDRAW.test(part) ? "" : part)
    .join("")
    .replace(ANSI, "");
};

/** Keep the first copy of each public diagnostic. Extractors that build a numerical
 * headline use this before counting so a retried/concatenated log cannot say more
 * failures were shown than survive the reader's final de-duplication. */
export function uniqueFailures(failures) {
  const seen = new Set();
  return failures.filter((failure) => {
    const key = JSON.stringify([
      failure.file ?? null, failure.line ?? null, failure.col ?? null,
      failure.title ?? "", failure.message ?? "", failure.stmt ?? "",
    ]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Node/py internals and vendored code are almost never what you're looking for. */
const NOISE = [
  /^node:/, /node:internal/, /[/\\]node_modules[/\\]/, /[/\\]site-packages[/\\]/,
  /[/\\]lib[/\\]python3\.\d+[/\\]/, /<frozen [a-z_.]+>/,
  /\.pnpm[/\\]/,
  // Ruby's stdlib and installed gems. A failing `require` is raised inside rubygems, so
  // without these the location reported for a missing gem was kernel_require.rb.
  /[/\\]gems[/\\]/, /[/\\]rubygems[/\\]/, /Ruby\.framework[/\\]/, /[/\\]lib[/\\]ruby[/\\]/,
  // node's own eval/REPL machinery — the [eval]:N frame is real, its wrapper is not
  /^\[eval\]-wrapper/, /^evalmachine/, /^\[stdin\]-wrapper/,
];
export const isNoise = (p) => !!p && NOISE.some((re) => re.test(p));

export function relPath(p) {
  if (!p) return p;
  const cwd = process.cwd();
  return p.startsWith(cwd + "/") ? p.slice(cwd.length + 1) : p;
}

/** Collapse runs of blank lines, trim trailing space. */
export const tidy = (lines) =>
  lines.map((l) => l.replace(/\s+$/, ""))
       .filter((l, i, a) => !(l === "" && a[i - 1] === ""));

// CI viewers stamp every line: GitHub Actions writes an ISO timestamp, and
// `gh run view --log` puts tab-separated job and step names in front of it.
// Every parser here anchors on ^, so an unstripped prefix makes all of them
// match nothing and the whole log comes back silent.
const CI_PREFIX = /^(?:[^\t\n]*\t){0,3}\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s/;

/** Strip a uniform CI line prefix, but only when nearly every line carries one -
 *  a log that merely mentions a timestamp must not be mangled. */
export function stripCiPrefix(text) {
  const lines = text.split("\n");
  let seen = 0, stamped = 0;
  for (const l of lines) {
    if (!l.trim()) continue;
    seen++;
    if (CI_PREFIX.test(l)) stamped++;
    if (seen > 200) break;
  }
  // No floor on how many lines a log needs. Requiring three meant a one-line log was
  // never unstamped - and a one-line log is precisely the one whose whole diagnosis is
  // that line, so `git: fatal: not a git repository` came back with nothing at all when
  // it arrived from a GitHub Actions raw log. 11 of the fixtures degraded that way and
  // two lost their diagnosis entirely.
  //
  // The floor was there so a short log that merely mentions a timestamp is not mangled.
  // The ratio still guards that, and the pattern is narrow: a full ISO-8601 instant with
  // the Z, at the very start, followed by whitespace. The worst a wrong strip can do is
  // remove a timestamp and leave the message; not stripping loses the whole diagnosis.
  if (!seen || stamped / seen < 0.8) return text;
  return lines.map((l) => l.replace(CI_PREFIX, "")).join("\n");
}

// A Go test with twenty-four subtests fails twenty-four times with the same assertion,
// and the parser gathers all of them into one message: "Unexpected response." printed
// twenty-four times, 503 characters saying one thing. No diagnosis is improved by
// repeating a sentence, so a run of identical lines becomes the line and a count.
//
// Only consecutive runs, so the shape of a diagnostic that alternates - "expected: X /
// got: Y / expected: Z / got: W" - is left alone. Three is the threshold: saying
// something twice is usually the tool making a point, and annotating it would be noisier
// than the repeat.
const MIN_RUN = 3;

/** Collapse runs of identical lines in a message into one line and a count. */
export function collapseRepeats(message) {
  if (typeof message !== "string" || !message.includes("\n")) return message;
  const lines = message.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; ) {
    let j = i;
    while (j < lines.length && lines[j] === lines[i]) j++;
    const run = j - i;
    out.push(run >= MIN_RUN && lines[i].trim() ? `${lines[i]} (x${run})` : lines[i]);
    if (run >= MIN_RUN && lines[i].trim()) i = j;
    else { out.push(...lines.slice(i + 1, j)); i = j; }
  }
  return out.join("\n");
}

/** Decode XML character data. Numeric references matter as much as the named five:
 *  mocha's xunit reporter writes `&#x3C;anonymous&#x3E;` where node's JUnit writes
 *  `&lt;`, and a parser that knows only the names leaves markup in the message. */
export function xmlText(value) {
  return String(value).replace(/&(?:#(\d+)|#x([\da-fA-F]+)|quot|apos|lt|gt|amp);/g, (entity, dec, hex) => {
    if (dec) return String.fromCodePoint(Number(dec));
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    return { "&quot;": '"', "&apos;": "'", "&lt;": "<", "&gt;": ">", "&amp;": "&" }[entity.toLowerCase()];
  });
}

/** The attributes of one XML start tag, decoded. */
export function xmlAttributes(tag) {
  const attributes = {};
  for (const match of tag.matchAll(/([\w:.-]+)="([^"]*)"/g)) attributes[match[1]] = xmlText(match[2]);
  return attributes;
}

/** Parse the JSON value that starts at `start`, or null.
 *
 *  Whitespace outside the strings is rewritten to a plain space on the way past: JSON
 *  admits only space, tab, CR and LF between its tokens, and a runner that re-indents
 *  what it relays - pnpm uses U+2009 THIN SPACE - otherwise leaves a report that will
 *  not parse at all. Inside a string the same character is data and is kept. */
function jsonValueAt(text, start) {
  const opener = text[start];
  const closer = opener === "[" ? "]" : "}";
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
    if (c === opener) depth++;
    else if (c === closer && --depth === 0) {
      try { return JSON.parse(out.join("")); } catch { return null; }
    }
  }
  return null;
}

/** The first JSON document in `text` that opens a line and that `accept` recognises.
 *
 *  A report pretty-printed across many lines cannot be found by looking for a line that
 *  parses, and starting at the first bracket in the log is worse than useless once a
 *  second tool has printed JSON of its own - the scan opens on somebody else's bracket
 *  and swallows the rest. Every bracket that opens a line is a candidate instead, and
 *  the first one the caller recognises wins. */
export function findJsonDocument(text, accept) {
  for (const open of text.matchAll(/^[^\S\n]*[[{]/gm)) {
    const value = jsonValueAt(text, open.index + open[0].length - 1);
    if (value !== null && accept(value)) return value;
  }
  return null;
}

// A tool asked for GitHub Actions output writes workflow commands, one per finding:
//
//   ::error title=lint/suspicious/noDebugger,file=src/cart.js,line=3,col=3::This is ...
//   ::warning file=bad.yml,line=1,col=1::1:1 [document-start] missing document start
//
// The shape is shared - biome, yamllint, eslint and jest all write it - and it carries
// severity, location and message but never the tool's own name. So this decodes the
// shape and the parsers decide which annotations are theirs, by what is inside them.
const ANNOTATION_RE = /^[^\S\n]*::(error|warning|notice)[^\S\n]+([^:\n]*)::(.*)$/;

/** The GitHub workflow annotations in `text`.
 *
 *  Reading one is not running one: the values are data here, and a log that contains
 *  `::error::` because some tool printed it is a log, not an instruction. */
export function githubAnnotations(text) {
  const out = [];
  for (const line of text.split("\n")) {
    const m = line.match(ANNOTATION_RE);
    if (!m) continue;
    const props = {};
    // `title` may contain a comma in principle; every other property is a number or a
    // path, and GitHub itself separates them with commas, so this is what it means.
    for (const pair of m[2].split(",")) {
      const eq = pair.indexOf("=");
      if (eq > 0) props[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    }
    // GitHub percent-escapes the three characters that would end the command early.
    const message = m[3].replace(/%0D/g, "").replace(/%0A/g, "\n").replace(/%25/g, "%");
    out.push({ severity: m[1], props, message });
  }
  return out;
}
