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

export const REPORT_VERSION = 1;

/** Everything whatbroke says about one run.
 *
 *  `analysis` is what analyse() read from the output, or null when nothing could be read;
 *  `raw` is the captured output; `error` is why a command could not be started. */
export function createReport({ analysis = null, raw = "", exitCode, inputMode, truncated = false, error = null, since = null }) {
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
    others: analysis?.others ?? null,
    exitCode,
    inputMode,
    commandExitCode: inputMode === "command" && !error ? exitCode : null,
    fallback,
    truncated,
    error,
    since,
    failures: analysis?.failures ?? [],
  };
}

/** What a fallback says, in every output, when the capture limit cut the log short. */
export const TRUNCATION_NOTICE = "output capture limit reached; captured output is incomplete (increase --max-bytes)";

/** A wrapper as a reader would name it: the prefix itself has a space on the end. */
export const wrapperName = (wrapper) => String(wrapper).trim();
