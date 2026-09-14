// Source ownership is deliberately private metadata. Symbols survive object spread,
// which lets the reader carry provenance through de-duplication and clustering, while
// JSON.stringify and every renderer continue to expose the version-1 public shape.
export const SOURCE_RANGE = Symbol("whatbroke.sourceRange");
const PARSER = Symbol("whatbroke.parser");

const clean = (value) => String(value ?? "").trim().replace(/\s+/g, " ");

function scoreLine(text, lineSet, index, failure, prepared) {
  if (!text) return 0;
  let score = 0;

  // The rendered message is a stronger ownership signal than a location. Different
  // tools routinely report the same generated file and line in one job (bun and
  // vitest are a real example); choosing the first shared location assigned both
  // parsers to bun's block even though vitest's own assertion was present later.
  if (prepared.messageLines.some((part) => text.includes(part) || part.includes(text))) score += 30;
  if (prepared.stmt && text.includes(prepared.stmt)) score += 8;
  if (failure.file && text.includes(String(failure.file))) {
    score += 8;
    if (failure.line && numbersOn(lineSet, index).has(String(failure.line))) score += 6;
    if (failure.col && numbersOn(lineSet, index).has(String(failure.col))) score += 2;
  }
  for (const needle of prepared.labels) {
    if (needle.length >= 3 && text.includes(needle)) score += 4;
  }
  for (const needle of prepared.frames) {
    if (needle.length >= 4 && (text.includes(needle) || needle.includes(text))) score += 5;
  }
  return score;
}

/** Locate the diagnostic lines which support one extracted failure.
 *
 * Extractors already return the facts they read from the log. This maps those facts
 * back to their lines once, at the parser boundary, so every extractor participates
 * without adding a serialised field to its output. A parser may later provide an
 * explicit SOURCE_RANGE; explicit provenance always wins over this compatibility path.
 */
export function addSourceRanges(text, result, budget = ownershipBudget()) {
  if (!result?.failures?.length) return result;

  // Deferred, because most runs never ask. Ranges exist so that two parsers describing
  // the same raw region can suppress one another, which only happens in a log holding
  // more than one tool - and this runs for EVERY parser that claims the text, winner and
  // losers alike. A single-tool log paid for all of it and read none of it: 90 eslint
  // problems inside a 100k-line build log cost 4.5s against 0.56s with the work skipped.
  //
  // The thunk computes every failure's range in one pass when the first one is asked
  // for, so the shared tie-breaking between them is exactly what it was.
  let ranges = null;
  const compute = () => (ranges ??= locate(text, result.failures, budget));
  const failures = result.failures.map((failure, i) =>
    failure[SOURCE_RANGE] ? failure : lazySourceRange(failure, () => compute()[i]));
  return { ...result, failures };
}

function lazySourceRange(failure, get) {
  const copy = { ...failure };
  Object.defineProperty(copy, SOURCE_RANGE, { get, enumerable: false, configurable: true });
  return copy;
}

// `path/to/file.ext:12:5`, as a location is written in a stack, a heading or a message.
// Only whether a line holds one is ever asked, and for that one character of the path
// before its extension says as much as all of it. Asking for all of it backtracked through
// every run of path characters from every position in the run: one 80,000-character run
// took seven seconds to decide it held no location.
const WRITTEN_LOCATION_RE = /[^\s()"'[\]]\.[A-Za-z]\w*:\d+:\d+/;

// Locating a failure searches every line of the log for it, so the work is the log's
// length times the distinct failures located - its length, not its lines: an eslint
// report is one line holding every finding, and 471 KB of table and report took three
// minutes. At the capture cap it became a hang: 10 MiB holding every fixture took 36
// seconds, three quarters of them here, spread over 36 tools that each located under
// any limit one call could set. So the limit is on the whole reading of a log, and past
// it a range is left unknown. An unknown range overlaps nothing, so the one thing ranges
// decide - that two tools' readings of the same text are one diagnosis - goes undecided
// and each tool keeps its own finding. That is the cheaper mistake: a finding shown
// twice, rather than one suppressed as a copy of something it was never compared with.
//
// 90 eslint problems in a 3.4 MB build log - the case that made ranges lazy - is 310
// million of this, and still located.
export const LOCATE_BUDGET = 500_000_000;

/** The work one reading of a log may spend locating, and the per-line preparation every
 *  tool's failures are scored against - the same lines, so prepared once. */
export function ownershipBudget(limit = LOCATE_BUDGET) {
  return { limit, spent: 0, text: null, lines: null, cleaned: null, numbers: null, writes: null, naming: null, released: false };
}

/** The reading is finished: keep what was spent, drop the prepared lines. A range asked
 *  for afterwards is still answered, from lines prepared for that one call. */
export function releaseOwnership(budget) {
  budget.text = budget.lines = budget.cleaned = budget.numbers = budget.writes = budget.naming = null;
  budget.released = true;
}

const identityOf = (failure) => JSON.stringify([
  failure.file ?? null, failure.line ?? null, failure.col ?? null,
  failure.title ?? "", failure.code ?? null, failure.subject ?? null,
  failure.label ?? null, failure.message ?? "", failure.stmt ?? null,
]);

// A line's numbers only matter on a line that names the failure's file, and most lines
// name none, so each set is made the first time such a line asks for it.
function preparedLines(text, budget) {
  if (budget.text === text) return budget;
  const lines = text.split("\n");
  const cleaned = lines.map(clean);
  const lineSet = { lines, cleaned, numbers: new Array(lines.length), writes: new Array(lines.length), naming: new Map() };
  if (budget.released) return lineSet;
  Object.assign(budget, { text }, lineSet);
  return budget;
}

const numbersOn = (prepared, index) =>
  (prepared.numbers[index] ??= new Set(prepared.cleaned[index].match(/\d+/g) ?? []));

/** Every line naming `file`, in order - asked once per file however many failures share it. */
function linesNaming(prepared, file) {
  let found = prepared.naming.get(file);
  if (!found) {
    found = [];
    prepared.cleaned.forEach((line, index) => { if (line.includes(file)) found.push(index); });
    prepared.naming.set(file, found);
  }
  return found;
}

/** The first position in ascending `sorted` holding a value at or above `value`. */
function firstAtOrAfter(sorted, value) {
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < value) lo = mid + 1; else hi = mid; }
  return lo;
}

// How many times ranges have been located. A log holding one tool never needs a range, and
// test/mixed.js holds the reader to never locating one for it.
let located = 0;
export const timesLocated = () => located;

function locate(text, all, budget) {
  const identities = all.map((failure) => (failure[SOURCE_RANGE] ? null : identityOf(failure)));
  const distinct = new Set(identities.filter(Boolean)).size;
  const work = text.length * distinct;
  if (budget.spent + work > budget.limit) return all.map((failure) => failure[SOURCE_RANGE] ?? null);
  budget.spent += work;
  located++;
  const lineSet = preparedLines(text, budget);
  const { lines, cleaned } = lineSet;
  const used = new Set();
  const known = new Map();
  return all.map((failure, i) => {
    if (failure[SOURCE_RANGE]) return failure[SOURCE_RANGE];
    // Repeated diagnostics are collapsed immediately after parsing. Locate identical
    // copies once rather than rescanning a large log for every repetition (a repeated
    // 90-error eslint block otherwise made this quadratic on Node 18).
    const identity = identities[i];
    if (known.has(identity)) return known.get(identity);
    const prepared = {
      messageLines: String(failure.message ?? "").split("\n").map(clean).filter((s) => s.length >= 4),
      stmt: clean(failure.stmt),
      labels: [failure.code, failure.subject, failure.label, failure.title].map(clean).filter(Boolean),
      frames: (failure.trace ?? []).map((frame) => clean(typeof frame === "string" ? frame : JSON.stringify(frame))),
    };
    // One pass for both: every line naming this failure's file, and the subset that also
    // carries its line number. The subset is a strong anchor and adjusts the score; the
    // whole set is only ever used to break a tie (below).
    const fileLines = [], lineAnchors = [], columnAnchors = [], writtenAnchors = [];
    let written = null;
    if (failure.file) {
      const file = String(failure.file);
      written = failure.line
        ? new RegExp(`${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:${failure.line}${failure.col ? `:${failure.col}` : ""}(?!\\d)`)
        : null;
      for (const index of linesNaming(lineSet, file)) {
        fileLines.push(index);
        if (failure.line && !numbersOn(lineSet, index).has(String(failure.line))) continue;
        lineAnchors.push(index);
        if (failure.col && numbersOn(lineSet, index).has(String(failure.col))) columnAnchors.push(index);
        if (written?.test(cleaned[index])) writtenAnchors.push(index);
      }
    }
    // A line that names the file and holds the right numbers somewhere is a weak anchor,
    // and a machine report written on one line is full of numbers. Two runs each reported
    // "mismatched types" at src/main.rs line 2 - rustc's text at column 22, cargo's JSON at
    // column 18 - and the text run's failure anchored on the JSON line, which holds the
    // file, a 2, a 22 in a byte offset, and the same message. The ranges overlapped and
    // the text run's failure was suppressed as a copy of a failure it was not.
    //
    // So the location written as a location - `src/main.rs:2:22` - anchors first, the
    // right numbers on the file's line next, and file and line last. Each tier is only
    // used where the one above it finds nothing, so a format that writes its location
    // differently, or counts columns from zero, anchors exactly as it did before.
    const locationAnchors = writtenAnchors.length ? writtenAnchors
      : columnAnchors.length ? columnAnchors : lineAnchors;
    const scored = [];
    for (let index = 0; index < cleaned.length; index++) {
      const score = scoreLine(cleaned[index], lineSet, index, failure, prepared);
      if (score > 0) scored.push({ index, score });
    }
    if (!scored.length) {
      const range = { start: 0, end: lines.length };
      known.set(identity, range);
      return range;
    }

    // Identical assertion text is common across tool runs. Prefer the occurrence close
    // to this failure's own file/line instead of assigning both parsers to whichever
    // copy appeared first in the combined log.
    //
    // Close is not the same as about. A line that writes a location of its own - and not
    // this one - is saying where something ELSE happened, however near it sits. mocha's
    // json-stream wrote "applies a discount" with its stack, `(test/cart.test.js:10:11)`,
    // eleven lines under Playwright's `at /app/tests/cart.spec.ts:9:9` for a test of the
    // same name that threw the same TypeError; nearness took Playwright's failure onto
    // mocha's line, and mocha's own failure was suppressed as its copy.
    const foreign = (index) => !!written && (lineSet.writes[index] ??= WRITTEN_LOCATION_RE.test(lines[index])) &&
      !written.test(lines[index]);
    const distance = locationAnchors.length ? (index) => {
      const at = firstAtOrAfter(locationAnchors, index);
      return Math.min(at < locationAnchors.length ? locationAnchors[at] - index : Infinity,
        at > 0 ? index - locationAnchors[at - 1] : Infinity);
    } : () => Infinity;
    const adjusted = ({ index, score }) => (foreign(index) ? score : score + Math.max(0, 32 - distance(index) * 2));
    // Two lines can match a failure equally well on content, and "whichever came first"
    // was the tie-break. That is arbitrary, and it was wrong in a way that lost a failure:
    // eslint's JSON report is one line holding every message in the run, so it ties with
    // the stylish table's own line for any failure that shares a message - and in a log
    // holding both, the JSON line came first, the table's failure was assigned to it,
    // and its range then overlapped the JSON parser's and it was suppressed as a copy.
    // Stylish puts the filename on its own header line with no line number, so the
    // anchor above never fires for it. Where the log names the file is still the right
    // question to ask, and asking it only to break a tie cannot overrule a better match.
    //
    // It has to be asked in one direction. A header-grouped table's lines belong to the
    // header ABOVE them, and fetch.js's twentieth problem sits twenty lines under its
    // header - further, measured both ways, than a JSON document eight lines above the
    // header that it has not even reached yet. So distance is to the nearest mention at
    // or before the line. Where no candidate has one - rustc names the file on the line
    // AFTER its message - they all tie here and the old order stands.
    const UNPLACED = Number.MAX_SAFE_INTEGER;
    const nearFile = (index) => {
      const after = firstAtOrAfter(fileLines, index + 1);
      return after > 0 ? index - fileLines[after - 1] : UNPLACED;
    };
    // Only the best candidate is taken, so it is picked out in one pass rather than found
    // by sorting all of them - with every comparison asking its questions again.
    let best = null;
    for (const entry of scored) {
      const c = { index: entry.index, score: entry.score, adjusted: adjusted(entry), used: used.has(entry.index) ? 1 : 0, near: nearFile(entry.index) };
      if (!best || (c.adjusted - best.adjusted || c.score - best.score || best.used - c.used || best.near - c.near || best.index - c.index) > 0) best = c;
    }
    const anchor = best.index;
    const start = anchor;
    const end = anchor + 1;
    for (let i = start; i < end; i++) used.add(i);
    const range = { start, end };
    known.set(identity, range);
    return range;
  });
}


/** Record that `failure` was read from lines [start, end) of the text its parser was given.
 *  A parser knows this as it reads; the guess made above is for the ones that do not yet
 *  say. Written ranges are what `test/evidence.js` holds to the text they point at. */
export function withSource(failure, start, end) {
  Object.defineProperty(failure, SOURCE_RANGE, { value: { start, end }, enumerable: false, configurable: true });
  return failure;
}

// How many places one diagnosis keeps. A run printed twice - as a table and as JSON - is
// two; a log holding the same finding thousands of times would make every join, and every
// comparison of ranges, cost as much as all the copies before it.
const MAX_PLACES = 8;

/** Every range in a range: the first, and the others it was also read from. */
const placesOf = (range) => (range.also ? [range, ...range.also] : [range]);

/** One diagnosis read in two places is kept once, and keeps both places.
 *
 *  A parser that reads one run printed two ways keeps one reading of each finding. A
 *  range written for that reading alone says the finding is in one place, and another
 *  tool's reading of the other place is then a stranger: ruff's full form wins over its
 *  concise lines, and flake8, reading those same concise lines, reported them again.
 *
 *  Returns `kept`, or a copy of it that carries the places `dropped` was read from as
 *  well. A guessed range is left as it is - a guess is about one line, and joining two
 *  would make both into claims. */
/** `failure`, or a copy of it, read from lines [start, end) as well as where it says -
 *  for a finding whose parts are in two places, like a test's result and the diagnostic
 *  its harness printed somewhere else. */
export function alsoFrom(failure, start, end) {
  return joinSources(failure, withSource({}, start, end));
}

export function joinSources(kept, dropped) {
  const a = Object.getOwnPropertyDescriptor(kept, SOURCE_RANGE);
  const b = Object.getOwnPropertyDescriptor(dropped, SOURCE_RANGE);
  if (!a?.value || !b?.value) return kept;
  const places = placesOf(a.value).map(({ start, end }) => ({ start, end }));
  for (const { start, end } of placesOf(b.value)) {
    if (places.length >= MAX_PLACES) break;
    if (!places.some((p) => p.start === start && p.end === end)) places.push({ start, end });
  }
  if (places.length === placesOf(a.value).length) return kept;
  const [first, ...also] = places;
  const copy = { ...kept };
  Object.defineProperty(copy, SOURCE_RANGE, { value: { ...first, also }, enumerable: false, configurable: true });
  return copy;
}

export function preserveSourceRange(from, to) {
  // Carry the accessor across rather than its value, so a copy made on the way to the
  // reader does not force a computation nothing has asked for.
  const own = from && Object.getOwnPropertyDescriptor(from, SOURCE_RANGE);
  if (own) Object.defineProperty(to, SOURCE_RANGE, { ...own, enumerable: false });
  return to;
}

export function sourceRange(failure) {
  return failure?.[SOURCE_RANGE] ?? null;
}

export function rangesOverlap(a, b) {
  const x = sourceRange(a), y = sourceRange(b);
  if (!x || !y) return false;
  for (const p of placesOf(x)) {
    for (const q of placesOf(y)) if (p.start < q.end && q.start < p.end) return true;
  }
  return false;
}

export function setParser(result, parser) {
  Object.defineProperty(result, PARSER, { value: parser, enumerable: false });
  return result;
}

export function parserOf(result) {
  return result?.[PARSER] ?? null;
}
