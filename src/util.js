import { joinSources } from "./ownership.js";

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
  const seen = new Map();
  const unique = [];
  for (const failure of failures) {
    const key = JSON.stringify([
      failure.file ?? null, failure.line ?? null, failure.col ?? null,
      failure.title ?? "", failure.message ?? "", failure.stmt ?? "",
    ]);
    // A copy says where it was read, and the first keeps that.
    if (seen.has(key)) unique[seen.get(key)] = joinSources(unique[seen.get(key)], failure);
    else { seen.set(key, unique.length); unique.push(failure); }
  }
  return unique;
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

/** Every match of `re` in `text`, in the order and with the groups `text.matchAll(re)`
 *  gives, for a pattern that reads an element's body lazily up to its closing tag.
 *
 *  `<testcase ...>([\s\S]*?)</testcase>` stops at the first closing tag after its start,
 *  so a start tag with none after it reads to the end of the text before it fails - and
 *  the engine then tries the next start tag, which does the same. A log that repeated an
 *  unclosed `<testcase ...>` line took time that grew as the square of its length. Whether
 *  any closing tag follows is a question the position of the last one answers without
 *  reading anything, so a start tag that cannot match is never tried, and the one that
 *  is tried is the same pattern, anchored where it starts.
 *
 *  `open` finds where an element can start, with its name as the first group when the
 *  pattern admits more than one. `close(name)` is what ends that element's body.
 *  `selfClosing` says the pattern also matches the `<name .../>` form, which has no body. */
export function* elements(text, re, { open, close, selfClosing = false }) {
  const anchored = new RegExp(re.source, `${re.flags.replace(/[gy]/g, "")}y`);
  const starts = new RegExp(open.source, `${open.flags.replace(/[gy]/g, "")}g`);
  const lastClose = new Map();
  const closesAfter = (name, at) => {
    if (!lastClose.has(name)) lastClose.set(name, text.lastIndexOf(close(name)));
    return lastClose.get(name) > at;
  };
  for (let from = 0; from < text.length;) {
    starts.lastIndex = from;
    const start = starts.exec(text);
    if (!start) return;
    const end = text.indexOf(">", start.index);
    if (end === -1) return;
    if ((selfClosing && text[end - 1] === "/") || closesAfter(start[1], end)) {
      anchored.lastIndex = start.index;
      const match = anchored.exec(text);
      if (match) {
        yield match;
        from = start.index + Math.max(match[0].length, 1);
        continue;
      }
    }
    from = start.index + 1;
  }
}

/** The first match `elements` would give - what `text.match(re)` gives for the pattern. */
export function firstElement(text, re, options) {
  for (const match of elements(text, re, options)) return match;
  return null;
}

// A line pattern of one shape - a head, whitespace, a lazy message, whitespace, and a tail
// held to the end of the line - matched as the regex matches it, in time that grows with
// the line instead of its square.
//
// The regex looks for its tail from every place its head could end, one character of
// message at a time, so a long line that almost matches - many heads, no tail - was read
// again from each of them. The tail is held to the end, so it can be in only one place:
// that place is found once, the head is tried where it can end in the order the regex
// tries it, and the whitespace and message between them are divided the way the regex's
// greedy separator and lazy message divide them. `test/bounds.js` holds each of these to
// the regex it stands for.
const LINE_TERMINATOR = /[\n\r\u2028\u2029]/;
const INLINE_SPACE = /[^\S\n]/;

/** The match `line` gives a pattern of the shape above, as `line.match(pattern)` gives it.
 *  tail: the part held to the end, from its first character (not the whitespace before
 *        it), ending in `$`. Its groups come last in the match.
 *  spaceBefore: the whitespace the pattern needs between message and tail: 0, 1 or 2.
 *  emptyMessage: whether the message may be empty - `.*?` - or not - `.+?`.
 *  heads(line, tailAt, clear): where the head can end, in the order the pattern tries,
 *        as { end, groups }. `clear(i, j)` says no line terminator lies in [i, j), which
 *        is what `.` in a head needs. The separator after the head is `[^\S\n]+`. */
export function tailFirst(line, { tail, spaceBefore, emptyMessage, heads }) {
  const t = tail.exec(line);
  if (!t) return null;
  const c = t.index;
  let w = c;
  while (w > 0 && INLINE_SPACE.test(line[w - 1])) w--;
  const counts = new Int32Array(line.length + 1);
  for (let i = 0; i < line.length; i++) counts[i + 1] = counts[i] + (LINE_TERMINATOR.test(line[i]) ? 1 : 0);
  const clear = (i, j) => counts[j] === counts[i];
  const shortest = emptyMessage ? 0 : 1;
  for (const head of heads(line, c, clear)) {
    let r = head.end;
    while (r < c && INLINE_SPACE.test(line[r])) r++;
    // The separator gives back one character at a time; the message takes the fewest.
    for (let s = r; s > head.end; s--) {
      const e = Math.max(s + shortest, w);
      if (e > c - spaceBefore || !clear(s, e)) continue;
      const match = [line, ...head.groups, line.slice(s, e), ...t.slice(1)];
      match.index = 0;
      match.input = line;
      return match;
    }
  }
  return null;
}

/** The places `line` has `place` (a sticky pattern starting at a `:`) after a head of at
 *  least `from + 1` characters, left to right, where `ok(p)` accepts the head [from, p). */
export function* colonPlaces(line, from, limit, place, ok) {
  for (let p = line.indexOf(":", from + 1); p !== -1 && p < limit; p = line.indexOf(":", p + 1)) {
    if (!ok(p)) continue;
    place.lastIndex = p;
    const m = place.exec(line);
    if (m) yield { end: place.lastIndex, groups: [line.slice(from, p), ...m.slice(1)] };
  }
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

/** The attributes of one XML start tag, decoded.
 *
 *  Either quote. XML allows both, and shellcheck's checkstyle report uses single ones
 *  throughout - so a reader that knew only double quotes found no attributes at all and
 *  read the whole document as empty. */
export function xmlAttributes(tag) {
  const attributes = {};
  for (const match of tag.matchAll(/([\w:.-]+)=(?:"([^"]*)"|'([^']*)')/g)) {
    attributes[match[1]] = xmlText(match[2] ?? match[3]);
  }
  return attributes;
}

/** Whitespace that is not JSON's. JSON admits only space, tab, CR and LF between its
 *  tokens, and a runner that re-indents what it relays - pnpm uses U+2009 THIN SPACE -
 *  otherwise leaves a report that will not parse at all. Inside a string the same
 *  character is data and is kept. These are the characters /\s/ matches beyond those four. */
const foreignSpace = (code) => code === 0x0b || code === 0x0c || code === 0xa0 || code === 0x1680 ||
  (code >= 0x2000 && code <= 0x200a) || code === 0x2028 || code === 0x2029 || code === 0x202f ||
  code === 0x205f || code === 0x3000 || code === 0xfeff;
const spaceOtherThanNewline = (code) => code === 0x09 || code === 0x0d || code === 0x20 || foreignSpace(code);

// A document nested inside this many others is not looked at. Every document that opens
// a line is a candidate, including each one inside another - a pretty-printed report
// puts its inner objects on lines of their own - so a log of brackets nested ten thousand
// deep would parse the same text ten thousand times over. The deepest in any real report
// here is 5, Playwright's.
const MAX_NESTING = 32;

let lastScan = { text: null, spans: [] };

/** Where every JSON document that opens a line begins and ends, in one pass over `text`.
 *
 *  Finding each document by scanning from its opening bracket made a log of lines that
 *  each open a brace quadratic: every scan ran to the end of the log, for every line,
 *  for every parser that reads JSON - 25 KB of `{` took twenty seconds. One pass can
 *  answer for all of them, because a document that parses never carries a string across
 *  a line: JSON has no raw newline in a string. So every line that a surviving document
 *  continues onto begins outside a string, the brackets on it mean the same thing to
 *  every document that reaches it, and a document still inside a string at a line's end
 *  is one JSON.parse would have refused anyway. */
function documentSpans(text) {
  if (lastScan.text === text) return lastScan.spans;
  // Most logs hold no bracket at the start of any line, and those need no pass at all.
  // A log that does is read from the line holding the first: a bracket above it is
  // deeper in the stack than any document below it, so it cannot change what they match.
  const first = /^[^\S\n]*[[{]/m.exec(text);
  if (!first) { lastScan = { text, spans: [] }; return lastScan.spans; }
  const found = [];              // [start, end] of each line-opening document, as each closes
  const stacks = { 0x7b: [], 0x5b: [] };
  const closes = { 0x7d: 0x7b, 0x5d: 0x5b };
  const foreign = [];            // foreign whitespace outside strings, in order
  let broken = 0;                // how many line ends a string was still open at
  let inString = false, escaped = false, lineOpen = true;
  for (let i = text.lastIndexOf("\n", first.index) + 1; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x0a) {
      if (inString) { broken++; inString = false; escaped = false; }
      lineOpen = true;
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (code === 0x5c) escaped = true;
      else if (code === 0x22) inString = false;
      continue;
    }
    if (code === 0x22) { inString = true; lineOpen = false; continue; }
    if (code === 0x7b || code === 0x5b) {
      stacks[code].push({ at: i, opensLine: lineOpen, broken });
      lineOpen = false;
      continue;
    }
    if (code === 0x7d || code === 0x5d) {
      const open = stacks[closes[code]].pop();
      // A string left open at a line end in between means the scan from that bracket
      // would have run on inside it: not a document.
      if (open?.opensLine && open.broken === broken) found.push([open.at, i]);
      lineOpen = false;
      continue;
    }
    if (foreignSpace(code)) foreign.push(i);
    if (!spaceOtherThanNewline(code)) lineOpen = false;
  }
  found.sort((a, b) => a[0] - b[0]);
  // How many documents contain each start: those opened before it, less those closed
  // before it. Both lists are sorted, so each count is two binary searches.
  const ends = found.map(([, end]) => end).sort((a, b) => a - b);
  const below = (sorted, value) => {
    let lo = 0, hi = sorted.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < value) lo = mid + 1; else hi = mid; }
    return lo;
  };
  const spans = [];
  found.forEach(([start, end], index) => {
    if (index - below(ends, start) >= MAX_NESTING) return;
    const first = below(foreign, start), last = below(foreign, end);
    spans.push({ start, end, foreign: first < last ? foreign.slice(first, last) : null });
  });
  lastScan = { text, spans };
  return spans;
}

function spanSource(text, { start, end, foreign }) {
  let source = text.slice(start, end + 1);
  if (foreign) {
    const chars = source.split("");
    for (const at of foreign) chars[at - start] = " ";
    source = chars.join("");
  }
  return source;
}

function parseSpan(text, span) {
  try { return JSON.parse(spanSource(text, span)); } catch { return null; }
}

/** `JSON.parse(source)` for a source it has already accepted, keeping where every object
 *  and array in it opens and closes: { value, places }, places mapping each to [open,
 *  close] offsets into `source`.
 *
 *  JSON.parse gives no positions, and a report pretty-printed across hundreds of lines
 *  says which lines hold each finding only through them. The value is built the way
 *  JSON.parse builds it - members in order, a repeated key keeping its first place and its
 *  last value, `__proto__` an ordinary key - so a parser reads the same document either
 *  way. test/evidence.js compares the two. The source is known to parse, so nothing here
 *  checks it again. */
export function parsePlaced(source) {
  const places = new WeakMap();
  const stack = [];
  let i = 0, root;
  const complete = (value) => {
    const top = stack[stack.length - 1];
    if (!top) { root = value; return; }
    if (top.array) top.node.push(value);
    else {
      if (top.key === "__proto__") Object.defineProperty(top.node, top.key, { value, writable: true, enumerable: true, configurable: true });
      else top.node[top.key] = value;
      top.key = undefined;
    }
  };
  const stringEnd = (from) => {
    for (let j = from + 1; ; j++) {
      const code = source.charCodeAt(j);
      if (code === 0x5c) j++;
      else if (code === 0x22) return j;
    }
  };
  while (root === undefined || stack.length) {
    let code = source.charCodeAt(i);
    while (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) code = source.charCodeAt(++i);
    const top = stack[stack.length - 1];
    if (code === 0x2c) { i++; continue; }
    if (code === 0x7d || code === 0x5d) {
      stack.pop();
      places.set(top.node, [top.open, i++]);
      complete(top.node);
      continue;
    }
    if (top && !top.array && top.key === undefined) {
      const end = stringEnd(i);
      top.key = JSON.parse(source.slice(i, end + 1));
      i = source.indexOf(":", end) + 1;
      continue;
    }
    if (code === 0x7b || code === 0x5b) {
      stack.push({ node: code === 0x7b ? {} : [], array: code === 0x5b, open: i++, key: undefined });
    } else if (code === 0x22) {
      const end = stringEnd(i);
      complete(JSON.parse(source.slice(i, end + 1)));
      i = end + 1;
    } else if (code === 0x74) { complete(true); i += 4; }
    else if (code === 0x66) { complete(false); i += 5; }
    else if (code === 0x6e) { complete(null); i += 4; }
    else {
      const from = i;
      for (code = source.charCodeAt(i); (code >= 0x30 && code <= 0x39) || code === 0x2d || code === 0x2b || code === 0x2e || code === 0x65 || code === 0x45; code = source.charCodeAt(++i));
      complete(Number(source.slice(from, i)));
    }
  }
  return { value: root, places };
}

/** The first JSON document in `text` that opens a line and that `accept` recognises.
 *
 *  A report pretty-printed across many lines cannot be found by looking for a line that
 *  parses, and starting at the first bracket in the log is worse than useless once a
 *  second tool has printed JSON of its own - the scan opens on somebody else's bracket
 *  and swallows the rest. Every bracket that opens a line is a candidate instead, and
 *  the first one the caller recognises wins. */
export function findJsonDocument(text, accept) {
  for (const value of jsonDocuments(text, accept)) return value;
  return null;
}

let lineStartsOf = { text: null, starts: null };

/** The line of `text` holding character `offset`, counted from 0. */
export function lineAt(text, offset) {
  if (lineStartsOf.text !== text) {
    const starts = [0];
    for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) starts.push(at + 1);
    lineStartsOf = { text, starts };
  }
  const { starts } = lineStartsOf;
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= offset) lo = mid; else hi = mid - 1; }
  return lo;
}

/** Where the JSON document `source`, written at offset `at` of `text`, put each of its
 *  parts: { value, where }. `value` is what JSON.parse gives for `source`, which must
 *  parse. `where(node)` is the lines [start, end) of `text` holding `node`, any object or
 *  array inside `value`; given anything else - a string, or nothing - it is the lines of
 *  the whole document. */
export function jsonPlaces(text, at, source) {
  const { value, places } = parsePlaced(source);
  const lines = (open, close) => ({ start: lineAt(text, at + open), end: lineAt(text, at + close) + 1 });
  const whole = lines(0, source.length - 1);
  return { value, where: (node) => { const place = node !== null && typeof node === "object" && places.get(node); return place ? lines(...place) : whole; } };
}

/** `jsonDocuments`, and where each document put each of its parts: { value, where }, as
 *  `jsonPlaces` gives them. */
export function* jsonDocumentsAt(text, accept) {
  for (const span of documentSpans(text)) {
    const accepted = parseSpan(text, span);
    if (accepted !== null && accept(accepted)) yield jsonPlaces(text, span.start, spanSource(text, span));
  }
}

/** Every JSON document in `text` that opens a line and that `accept` recognises.
 *
 *  One report is not always one document: `go vet -json` writes a separate object per
 *  package, concatenated with nothing between them, so stopping at the first one reads
 *  one package and silently drops the rest. Each caller gets values of its own, parsed
 *  for it, so no parser can change what another one reads. */
export function* jsonDocuments(text, accept) {
  for (const span of documentSpans(text)) {
    const value = parseSpan(text, span);
    if (value !== null && accept(value)) yield value;
  }
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
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const m = lines[index].match(ANNOTATION_RE);
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
    out.push({ severity: m[1], props, message, line: index });
  }
  return out;
}
