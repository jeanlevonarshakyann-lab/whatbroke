// One report for every output.
//
// What a run found and the facts about the run itself - its exit code, whether the
// capture was cut short, what changed since last time - used to be put together three
// times: once into the object `--json` printed, and twice more by the terminal and the
// GitHub writers, each from the analysis and a handful of loose arguments. Each could
// drift from the others without a test noticing, and one had: the wrapper whatbroke took
// off a log, which the README promised it would name, reached none of the three.
//
// Now there is one object, built here, in the shape `--json` prints. The terminal and
// GitHub Actions render the same object, report.schema.json describes it, and
// test/report.js holds every report the corpus produces to that description.

import { linesOf, sourceRange } from "./ownership.js";

export const REPORT_VERSION = 1;

/** The lines of the output a failure was read from, counting from 1: `{ start, end }`
 *  inclusive, in order, apart. `lines` maps the lines of the parsed text onto the lines of
 *  the captured text, and `captured` the captured text's onto the output's own when the
 *  capture was cut short - what was elided still counts, so the numbers are the output's. */
function evidenceOf(failure, lines, captured) {
  const range = sourceRange(failure);
  if (!range || !lines) return [];
  const runs = [];
  for (const place of [range, ...(range.also ?? [])]) {
    for (const run of lines(place.start, place.end)) {
      for (const { start, end } of captured ? captured(run.start, run.end) : [run]) runs.push({ start, end });
    }
  }
  runs.sort((a, b) => a.start - b.start);
  const apart = [];
  for (const run of runs) {
    const last = apart.at(-1);
    if (last && run.start <= last.end + 1) last.end = Math.max(last.end, run.end);
    else apart.push({ ...run });
  }
  return apart.map(({ start, end }) => ({ start: start + 1, end: end + 1 }));
}

/** Everything whatbroke says about one run.
 *
 *  `analysis` is what analyse() read from the output, or null when nothing could be read;
 *  `raw` is the captured output; `error` is why a command could not be started; `lines` is
 *  the capture's map of its lines onto the output's, when it was cut short. */
export function createReport({ analysis = null, raw = "", exitCode, inputMode, truncated = false, error = null, since = null, lines = null }) {
  const parsed = linesOf(analysis);
  const withEvidence = (failures) => failures.map((f) => ({ ...f, evidence: evidenceOf(f, parsed, lines) }));
  // Unreadable output that something should have explained. A command that succeeded, or
  // an empty pipe, has nothing to fall back to.
  const fallback = !analysis && (exitCode !== 0 || (inputMode === "pipe" && raw.length > 0)) ? {
    reason: error ? "spawn-error" : raw.length ? "unrecognized-output" : "no-output",
    message: error ? `Command could not be started (exit code ${exitCode}).`
      : inputMode === "pipe" ? "Unrecognized input. Upstream command exit status is unknown."
      : `Command failed with exit code ${exitCode}.`,
    rawOutput: raw,
  } : null;
  return {
    version: REPORT_VERSION,
    tool: analysis?.tool ?? null,
    summary: analysis?.summary ?? null,
    guessed: analysis?.guessed ?? false,
    wrappers: analysis?.wrappers ?? [],
    clusters: analysis?.clusters ?? null,
    others: analysis?.others?.map((other) => ({ ...other, failures: withEvidence(other.failures) })) ?? null,
    exitCode,
    inputMode,
    commandExitCode: inputMode === "command" && !error ? exitCode : null,
    fallback,
    truncated,
    error,
    since,
    failures: withEvidence(analysis?.failures ?? []),
  };
}

/** What a fallback says, in every output, when the capture limit cut the log short. */
export const TRUNCATION_NOTICE = "output capture limit reached; captured output is incomplete (increase --max-bytes)";

/** A wrapper as a reader would name it: the prefix itself has a space on the end. */
export const wrapperName = (wrapper) => String(wrapper).trim();
