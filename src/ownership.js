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
  const lines = text.split("\n");
  const cleaned = lines.map(clean);
  const numbers = cleaned.map((line) => new Set(line.match(/\d+/g) ?? []));
  const used = new Set();
  const failures = result.failures.map((failure) => {
    if (failure[SOURCE_RANGE]) return failure;
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
    if (!scored.length) return withSourceRange(failure, { start: 0, end: lines.length });

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
    return withSourceRange(failure, { start, end });
  });
  return { ...result, failures };
}

function withSourceRange(failure, range) {
  const copy = { ...failure };
  Object.defineProperty(copy, SOURCE_RANGE, { value: range, enumerable: false });
  return copy;
}

export function preserveSourceRange(from, to) {
  const range = sourceRange(from);
  if (range) Object.defineProperty(to, SOURCE_RANGE, { value: range, enumerable: false });
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
