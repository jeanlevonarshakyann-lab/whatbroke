// Where each failure was read from is private metadata. Symbols survive object spread,
// which lets the reader carry provenance through de-duplication and clustering, while
// JSON.stringify and every renderer continue to expose the version-1 public shape.
//
// Every parser writes it down as it reads: which lines of the text it was given each
// failure came from. Two tools' readings are one diagnosis when their text agrees and
// those lines overlap. For a while the lines were guessed instead - every line of the log
// scored against each failure and the best one taken - and the guess was wrong often
// enough to lose a failure or show one twice; test/evidence.js and test/fuzz.js now hold
// every parser to writing its own. A failure that somehow carries none overlaps nothing,
// so both readings of it are kept: a finding shown twice rather than one hidden.
export const SOURCE_RANGE = Symbol("whatbroke.sourceRange");
const PARSER = Symbol("whatbroke.parser");
const LINES = Symbol("whatbroke.lines");

/** Record that `failure` was read from lines [start, end) of the text its parser was given.
 *  A parser knows this as it reads. Written ranges are what `test/evidence.js` holds to the
 *  text they point at. */
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

/** `places` - in order, apart and not touching - with lines [start, end) among them. Lines
 *  that touch or overlap one already there are the same stretch of the log, and become one
 *  place: a test's result line and the message lines under it are one reading, not three. */
function withPlace(places, { start, end }) {
  const out = [];
  let from = start, to = end, added = false;
  for (const p of places) {
    if (p.end < from) out.push(p);
    else if (to < p.start) { if (!added) { out.push({ start: from, end: to }); added = true; } out.push(p); }
    else { from = Math.min(from, p.start); to = Math.max(to, p.end); }
  }
  if (!added) out.push({ start: from, end: to });
  return out;
}

/** `failure`, or a copy of it, read from lines [start, end) as well as where it says -
 *  for a finding whose parts are in two places, like a test's result and the diagnostic
 *  its harness printed somewhere else. */
export function alsoFrom(failure, start, end) {
  return joinSources(failure, withSource({}, start, end));
}

/** One diagnosis read in two places is kept once, and keeps both places.
 *
 *  A parser that reads one run printed two ways keeps one reading of each finding. A
 *  range written for that reading alone says the finding is in one place, and another
 *  tool's reading of the other place is then a stranger: ruff's full form wins over its
 *  concise lines, and flake8, reading those same concise lines, reported them again.
 *
 *  Returns `kept`, or a copy of it that carries the places `dropped` was read from as
 *  well, the earliest first. Where either carries no range there is nothing to join. */
export function joinSources(kept, dropped) {
  const a = Object.getOwnPropertyDescriptor(kept, SOURCE_RANGE);
  const b = Object.getOwnPropertyDescriptor(dropped, SOURCE_RANGE);
  if (!a?.value || !b?.value) return kept;
  const had = placesOf(a.value).reduce(withPlace, []);
  let places = had;
  for (const place of placesOf(b.value)) {
    const next = withPlace(places, place);
    if (next.length > MAX_PLACES) break;
    places = next;
  }
  const unchanged = places.length === placesOf(a.value).length &&
    places.every((p, i) => p.start === placesOf(a.value)[i].start && p.end === placesOf(a.value)[i].end);
  if (unchanged) return kept;
  const [first, ...also] = places;
  const copy = { ...kept };
  Object.defineProperty(copy, SOURCE_RANGE, { value: also.length ? { ...first, also } : first, enumerable: false, configurable: true });
  return copy;
}

/** `failure` read from a text rebuilt out of the log, with its places moved onto the log's
 *  own lines: `origin[k]` is the line of the log that line k of the rebuilt text came from.
 *  go test -json is read as the verbose log its events carry, and the lines a failure was
 *  read from are the events, not the log they rebuild. */
export function throughOrigin(failure, origin) {
  const own = Object.getOwnPropertyDescriptor(failure, SOURCE_RANGE);
  if (!own?.value) return failure;
  const [first, ...also] = placesOf(own.value)
    .map(({ start, end }) => ({ start: origin[start], end: origin[end - 1] + 1 }))
    .reduce(withPlace, []);
  const copy = { ...failure };
  Object.defineProperty(copy, SOURCE_RANGE, { value: also.length ? { ...first, also } : first, enumerable: false, configurable: true });
  return copy;
}

export function preserveSourceRange(from, to) {
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

/** Record, on a reading of a log, how the lines its parsers were given are lines of the log
 *  itself: `lines(start, end)` is lines [start, end) of the parsed text as the runs of the
 *  log's own lines they are, `{ start, end }` inclusive and counting from 0. */
export function setLines(result, lines) {
  Object.defineProperty(result, LINES, { value: lines, enumerable: false });
  return result;
}

export function linesOf(result) {
  return result?.[LINES] ?? null;
}

export function setParser(result, parser) {
  Object.defineProperty(result, PARSER, { value: parser, enumerable: false });
  return result;
}

export function parserOf(result) {
  return result?.[PARSER] ?? null;
}
