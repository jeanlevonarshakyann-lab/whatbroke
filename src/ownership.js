// Source ownership is deliberately private metadata. Symbols survive object spread,
// which lets the reader carry provenance through de-duplication and clustering, while
// JSON.stringify and every renderer continue to expose the version-1 public shape.
export const SOURCE_RANGE = Symbol("whatbroke.sourceRange");
const PARSER = Symbol("whatbroke.parser");

const clean = (value) => String(value ?? "").trim().replace(/\s+/g, " ");

function scoreLine(text, numbers, failure, prepared) {
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
    if (failure.line && numbers.has(String(failure.line))) score += 6;
    if (failure.col && numbers.has(String(failure.col))) score += 2;
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
export function addSourceRanges(text, result) {
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
  const compute = () => (ranges ??= locate(text, result.failures));
  const failures = result.failures.map((failure, i) =>
    failure[SOURCE_RANGE] ? failure : lazySourceRange(failure, () => compute()[i]));
  return { ...result, failures };
}

function lazySourceRange(failure, get) {
  const copy = { ...failure };
  Object.defineProperty(copy, SOURCE_RANGE, { get, enumerable: false, configurable: true });
  return copy;
}

function locate(text, all) {
  const lines = text.split("\n");
  const cleaned = lines.map(clean);
  const numbers = cleaned.map((line) => new Set(line.match(/\d+/g) ?? []));
  const used = new Set();
  const known = new Map();
  return all.map((failure) => {
    if (failure[SOURCE_RANGE]) return failure[SOURCE_RANGE];
    // Repeated diagnostics are collapsed immediately after parsing. Locate identical
    // copies once rather than rescanning a large log for every repetition (a repeated
    // 90-error eslint block otherwise made this quadratic on Node 18).
    const identity = JSON.stringify([
      failure.file ?? null, failure.line ?? null, failure.col ?? null,
      failure.title ?? "", failure.code ?? null, failure.subject ?? null,
      failure.label ?? null, failure.message ?? "", failure.stmt ?? null,
    ]);
    if (known.has(identity)) return known.get(identity);
    const prepared = {
      messageLines: String(failure.message ?? "").split("\n").map(clean).filter((s) => s.length >= 4),
      stmt: clean(failure.stmt),
      labels: [failure.code, failure.subject, failure.label, failure.title].map(clean).filter(Boolean),
      frames: (failure.trace ?? []).map((frame) => clean(typeof frame === "string" ? frame : JSON.stringify(frame))),
    };
    const locationAnchors = failure.file ? cleaned.flatMap((line, index) =>
      line.includes(String(failure.file)) && (!failure.line || numbers[index].has(String(failure.line))) ? [index] : []) : [];
    const scored = cleaned.map((line, index) => ({ index, score: scoreLine(line, numbers[index], failure, prepared) }))
      .filter((entry) => entry.score > 0);
    if (!scored.length) {
      const range = { start: 0, end: lines.length };
      known.set(identity, range);
      return range;
    }

    // Identical assertion text is common across tool runs. Prefer the occurrence close
    // to this failure's own file/line instead of assigning both parsers to whichever
    // copy appeared first in the combined log.
    const adjusted = ({ index, score }) => {
      const distance = locationAnchors.length
        ? Math.min(...locationAnchors.map((anchor) => Math.abs(anchor - index)))
        : Infinity;
      return score + Math.max(0, 32 - distance * 2);
    };
    scored.sort((a, b) => adjusted(b) - adjusted(a) || b.score - a.score ||
      Number(used.has(a.index)) - Number(used.has(b.index)) || a.index - b.index);
    const anchor = scored[0].index;
    const start = anchor;
    const end = anchor + 1;
    for (let i = start; i < end; i++) used.add(i);
    const range = { start, end };
    known.set(identity, range);
    return range;
  });
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
  return !!x && !!y && x.start < y.end && y.start < x.end;
}

export function setParser(result, parser) {
  Object.defineProperty(result, PARSER, { value: parser, enumerable: false });
  return result;
}

export function parserOf(result) {
  return result?.[PARSER] ?? null;
}
