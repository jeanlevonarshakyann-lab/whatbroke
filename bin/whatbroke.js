#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createRequire } from "node:module";
import { constants as osConstants } from "node:os";
import { analyse } from "../src/index.js";
import { createCapture } from "../src/capture.js";
import {
  runIdentity,
  legacyRunIdentity,
  loadRun,
  loadLegacyRun,
  saveRun,
  compare,
  trackedCauseId,
  legacyTrackedCauseId,
} from "../src/history.js";
import { renderReport, setColor } from "../src/render.js";
import { githubOutput } from "../src/github.js";
import { createReport } from "../src/report.js";
const { version } = createRequire(import.meta.url)("../package.json");

const argv = process.argv.slice(2);
const HELP = `whatbroke — you ran a command, it printed 400 lines. these are the ones that matter.

  whatbroke <command...>     run it, then distil the failure
  whatbroke -q <command...>  hide the command's own output; show only the distillation
  <command> |& whatbroke     distil output piped in (optional trailing -)

  -q, --quiet   suppress the wrapped command's output
  -a, --all     don't cap the number of failures shown
      --no-source  don't read source files for context
      --no-cluster don't group failures that share a likely cause
      --since-last mark causes that are new since the last tracked run
      --max-bytes N  cap captured command output (default: 10485760)
  -j, --json    machine-readable output (same as --format json)
  -g, --github-actions  clickable GitHub Actions annotations (same as --format github)
      --format  terminal, json, or github
  -v, --version print the installed version
  -h, --help
`;

const flags = new Set();
const allowedFlags = new Set([
  "-q", "--quiet", "-a", "--all", "-j", "--json", "-g", "--github-actions",
  "-v", "--version", "-h", "--help", "--no-source", "--no-cluster", "--since-last",
]);
let format;
let maxBytes = 10 * 1024 * 1024;
let parseError;
while (argv.length && /^-/.test(argv[0])) {
  const a = argv.shift();
  if (a === "--") break;
  if (a === "-") continue; // Preserve the conventional explicit stdin marker.
  if (a === "--max-bytes" || a.startsWith("--max-bytes=")) {
    const value = a === "--max-bytes" ? argv.shift() : a.slice("--max-bytes=".length);
    maxBytes = Number(value);
    if (!/^\d+$/.test(value ?? "") || !Number.isSafeInteger(maxBytes) || maxBytes < 1024) {
      parseError = "--max-bytes must be an integer of at least 1024";
      break;
    }
    continue;
  }
  if (a === "--format" || a.startsWith("--format=")) {
    format = a === "--format" ? argv.shift() : a.slice("--format=".length);
    if (!format || format.startsWith("-")) {
      parseError = "--format requires terminal, json, or github";
      break;
    }
    if (!["terminal", "json", "github"].includes(format)) {
      parseError = `unknown format "${format}" (expected terminal, json, or github)`;
      break;
    }
    continue;
  }
  const expanded = a.startsWith("--") || a === "-" ? [a] : a.slice(1).split("").map((c) => "-" + c);
  for (const f of expanded) {
    if (!allowedFlags.has(f)) { parseError = `unknown option "${f}"`; break; }
    flags.add(f);
  }
  if (parseError) break;
}
const has = (...names) => names.some((n) => flags.has(n));
if (parseError) {
  process.stderr.write(`whatbroke: ${parseError}\n`);
  process.exit(2);
}
format ??= has("-j", "--json") ? "json" : has("-g", "--github-actions") ? "github" : "terminal";
if (has("-h", "--help")) { process.stdout.write(HELP); process.exit(0); }
if (has("-v", "--version")) { process.stdout.write(`${version}\n`); process.exit(0); }

const inputMode = argv.length ? "command" : "pipe";
const color = !process.env.NO_COLOR && process.stdout.isTTY;
setColor(color);
const json = format === "json";
const githubActions = format === "github";
const noSource = has("--no-source");
const noCluster = has("--no-cluster");
const sinceLast = has("--since-last");
// JSON stdout must remain valid even when the wrapped command writes to stdout.
const quiet = has("-q", "--quiet") || json;
const opts = { max: has("-a", "--all") ? Infinity : 5 };

/** The job summary is a file GitHub names in the environment. Writing it can fail - a
 *  runner can hand over a path that is not writable - and that must not fail the run. */
function appendGithubSummary(text) {
  const target = process.env.GITHUB_STEP_SUMMARY;
  if (!target || !text) return;
  try { appendFileSync(target, text); }
  catch (error) { process.stderr.write(`whatbroke: could not write GitHub summary: ${error.message}\n`); }
}

/** Compare this run's causes with the last recorded one, then record this one.
 *
 *  Only a run that finished and parsed is recorded. A truncated capture or a command
 *  that never started holds an incomplete list of causes, and storing it would make
 *  the NEXT run announce everything it lost as newly appeared. */
function track(r, truncated, executionError) {
  if (!r) return { compared: false, reason: "nothing-parsed", fresh: [], gone: null };
  const pairs = new Map();
  for (const tool of [r, ...(r.others ?? [])]) {
    for (const failure of tool.failures) {
      const current = trackedCauseId(failure, tool.tool);
      if (!pairs.has(current)) pairs.set(current, legacyTrackedCauseId(failure, tool.tool));
    }
  }
  const ids = [...pairs.keys()];
  const identityParts = { cwd: process.cwd(), tool: r.tool, argv };
  const identity = runIdentity(identityParts);
  const trustworthy = !truncated && !executionError;
  let previous = loadRun(identity);
  let comparisonIds = ids;
  let migrated = false;
  if (!previous) {
    previous = loadLegacyRun(legacyRunIdentity(identityParts));
    if (previous) {
      comparisonIds = [...pairs.values()];
      migrated = true;
    }
  }
  const result = compare(previous, comparisonIds, { truncated, trustworthy });
  if (migrated) {
    const freshLegacy = new Set(result.fresh);
    result.fresh = [...pairs].filter(([, legacy]) => freshLegacy.has(legacy)).map(([current]) => current);
    result.gone = null;
    result.goneWithheld = "identity-migration";
    result.migrated = true;
  }
  if (trustworthy) {
    result.recorded = saveRun(identity, { ranAt: new Date().toISOString(), tool: r.tool, causes: ids });
  } else {
    result.recorded = false;
  }
  return result;
}

let reported = false;
function report(raw, code, truncated = false, executionError = null, lines = null) {
  // Spawn errors are followed by a close event. Emit exactly one result while
  // allowing stdout to drain instead of cutting off a large JSON/raw fallback.
  if (reported) return;
  reported = true;
  // argv is what the user actually ran; it is evidence for detection, not decoration.
  const analysis = analyse(raw, { cluster: !noCluster, command: inputMode === "command" ? argv : null });
  const since = sinceLast ? track(analysis, truncated, executionError) : null;
  const result = createReport({ analysis, raw, exitCode: code, inputMode, truncated, error: executionError, since, lines });
  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else if (githubActions) {
    const { stdout, summary } = githubOutput(result, { quiet });
    process.stdout.write(stdout);
    appendGithubSummary(summary);
  } else {
    process.stdout.write(renderReport(result, { ...opts, source: !noSource, cluster: !noCluster, quiet }));
  }
  process.exitCode = code;
}

if (argv.length === 0) {
  if (process.stdin.isTTY) { process.stdout.write(HELP); process.exit(0); }
  // No setEncoding: decoding each chunk and re-encoding it to measure bytes is what
  // used to split multi-byte characters at the cap. Buffers in, one decode at the end.
  const capture = createCapture(maxBytes);
  process.stdin.on("data", (d) => capture.push(d));
  process.stdin.on("end", () => {
    const { text, truncated, lines } = capture.finish();
    report(text, 0, truncated, null, lines);
  });
} else {
  // A command that never starts is still a command that failed, and saying so is this
  // tool's whole job - so the two ways node reports that have to end in the same place.
  // A command that is not there arrives as an "error" event on the child. A file the
  // kernel refuses to exec - no shebang, or built for another architecture - is thrown
  // by spawn() itself, so there is no child to attach a handler to and the throw lands
  // in the user's terminal as a node stack trace. pnpm installs a placeholder binary
  // with no shebang, which is how `whatbroke -- pnpm test` found this.
  const startFailed = (e) => {
    // The ENOENT message names the file; the ENOEXEC one is the bare "spawn ENOEXEC",
    // and a report that cannot say WHICH command failed to start is worth little in a
    // log that ran ten of them.
    const said = e.message.includes(argv[0]) ? e.message : `spawn ${argv[0]} ${e.code ?? e.message}`;
    process.stderr.write(`whatbroke: ${said}\n`);
    report("", 127, false, said);
  };
  let child = null;
  try {
    child = spawn(argv[0], argv.slice(1), { stdio: ["inherit", "pipe", "pipe"] });
  } catch (e) { startFailed(e); }
  if (child) {
    // Both streams share one budget, so interleaved stdout/stderr keeps its ordering
    // within each stream and the cap still means what --max-bytes says it means.
    const capture = createCapture(maxBytes);
    const tap = (stream, out, suppress) => {
      stream.on("data", (d) => {
        if (!suppress) out.write(d);
        capture.push(d);
      });
    };
    tap(child.stdout, process.stdout, quiet);
    // Keep diagnostics visible on stderr while JSON remains clean on stdout.
    tap(child.stderr, process.stderr, quiet && !json);
    child.on("error", startFailed);
    child.on("close", (code, signal) => {
      if (code === 0 && !json) { process.exitCode = 0; return; }
      const signalCode = signal ? 128 + (osConstants.signals?.[signal] ?? 1) : null;
      const { text, truncated, lines } = capture.finish();
      report(text, code ?? signalCode ?? 1, truncated, null, lines);
    });
  }
}
