#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { constants as osConstants } from "node:os";
import { analyse } from "../src/index.js";
import { createCapture } from "../src/capture.js";
import { relay } from "../src/stream.js";
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

// A reader that goes away first — `whatbroke npm test | head`, or `| less` closed before
// the end — closes the pipe under us. node ignores SIGPIPE and raises EPIPE on the stream
// instead, and an unhandled 'error' event on stdout is a node stack trace printed by the
// tool whose whole job is to keep those off the screen. There is nothing left to say to a
// closed pipe, so say nothing; anything else that stops a write, a full disk say, cannot
// be reported either and is left in the exit code.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (e) => {
    if (e?.code === "EPIPE" || e?.code === "ERR_STREAM_DESTROYED") return;
    process.exitCode ||= 1;
  });
}

const argv = process.argv.slice(2);
const HELP = `whatbroke — you ran a command, it printed 400 lines. these are the ones that matter.

  whatbroke <command...>     run it, then distil the failure
  whatbroke -q <command...>  hide the command's own output; show only the distillation
  <command> |& whatbroke     distil output piped in (optional trailing -)
  whatbroke < build.log      distil a log file you already have

  -q, --quiet   suppress the wrapped command's output
  -a, --all     don't cap the number of failures shown
      --no-source  don't read source files for context
      --no-cluster don't group failures that share a likely cause
      --since-last mark causes that are new since the last tracked run
      --id NAME    name this pipeline, so a piped log can use --since-last
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
let runId;
let maxBytes = 10 * 1024 * 1024;
let parseError;
while (argv.length && /^-/.test(argv[0])) {
  const a = argv.shift();
  if (a === "--") break;
  if (a === "-") continue; // Preserve the conventional explicit stdin marker.
  if (a === "--id" || a.startsWith("--id=")) {
    runId = a === "--id" ? argv.shift() : a.slice("--id=".length);
    if (!runId || runId.startsWith("-")) { parseError = "--id requires a name"; break; }
    continue;
  }
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
 *  Only a run that finished is recorded. A truncated capture or a command that never
 *  started holds an incomplete list of causes, and storing it would make the NEXT run
 *  announce everything it lost as newly appeared.
 *
 *  A command that EXITED ZERO is the one run that can be recorded without having parsed
 *  anything: nothing is failing, and that is the whole list. Before, a green run wrote
 *  nothing at all, so the record still held yesterday's failure - and when that failure
 *  came back the next day, whatbroke compared it against itself and said nothing was new.
 *  A passing run in between is exactly when a reader most wants the next break called new. */
function track(r, truncated, executionError, code = null) {
  const succeeded = code === 0 && !executionError && inputMode === "command";
  if (!r && !succeeded) return { compared: false, reason: "nothing-parsed", fresh: [], gone: null };
  // What this run says is failing. A command that exited ZERO says nothing is, whatever
  // its output looked like - a runner echoing the previous run's summary, a suite printing
  // failures it was configured to tolerate, a linter reporting warnings. The terminal path
  // never reaches here with a reading, so it recorded the empty baseline correctly; JSON
  // does reach here, and recorded the reading instead - so the same command succeeding
  // left a record saying those causes were still live, and the two modes disagreed.
  // The report itself still carries everything that was read; only the baseline is empty.
  const read = succeeded ? null : r;
  const pairs = new Map();
  for (const tool of read ? [read, ...(read.others ?? [])] : []) {
    for (const failure of tool.failures) {
      const current = trackedCauseId(failure, tool.tool);
      if (!pairs.has(current)) pairs.set(current, legacyTrackedCauseId(failure, tool.tool));
    }
  }
  const ids = [...pairs.keys()];
  const identityParts = { cwd: process.cwd(), tool: read?.tool ?? null, argv, id: runId };
  const identity = runIdentity(identityParts);
  // A piped log nobody named cannot be told from any other piped log in the same
  // directory. Comparing them claims one pipeline's failures were fixed by another's run.
  if (!identity) return { compared: false, reason: "unidentified-pipe", fresh: [], gone: null, recorded: false };
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
  const result = compare(previous, comparisonIds, { truncated, trustworthy, tool: read?.tool ?? null });
  if (migrated) {
    const freshLegacy = new Set(result.fresh);
    result.fresh = [...pairs].filter(([, legacy]) => freshLegacy.has(legacy)).map(([current]) => current);
    result.gone = null;
    result.goneWithheld = "identity-migration";
    result.migrated = true;
  }
  if (trustworthy) {
    result.recorded = saveRun(identity, { ranAt: new Date().toISOString(), tool: read?.tool ?? null, causes: ids });
  } else {
    result.recorded = false;
  }
  return result;
}

let reported = false;
function report(raw, code, truncated = false, executionError = null, lines = null, signal = null) {
  // Spawn errors are followed by a close event. Emit exactly one result while
  // allowing stdout to drain instead of cutting off a large JSON/raw fallback.
  if (reported) return;
  reported = true;
  // argv is what the user actually ran; it is evidence for detection, not decoration.
  const analysis = analyse(raw, { cluster: !noCluster, command: inputMode === "command" ? argv : null });
  const since = sinceLast ? track(analysis, truncated, executionError, code) : null;
  const result = createReport({ analysis, raw, exitCode: code, inputMode, truncated, error: executionError, since, lines, signal });
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
  // A failed spawn can throw before it returns a child, or emit an error afterward.
  // Both paths must report the command that failed and preserve exit code 127.
  // What the shell would have said. A command that will not start is most often a typo,
  // and "spawn pyest ENOENT" is node's wording for it - the reader gets an internal error
  // string where every shell they have ever used says "command not found". The errno is
  // kept on the end, because it is what a bug report needs and what the schema's `error`
  // has always carried.
  // A log already on disk is not on $PATH, so `whatbroke build.log` misses with ENOENT
  // and `whatbroke ./build.log` with EACCES. Either way the file is sitting right there.
  // Reading it unasked would make a mistyped command name silently distil whatever file
  // happens to share it, so say how instead of guessing. Only a file that cannot be run
  // qualifies: a script that failed on its shebang is one the user meant to execute.
  const runnable = (st) => (process.platform === "win32"
    ? /\.(?:exe|bat|cmd|com|ps1)$/i.test(argv[0])
    : (st.mode & 0o111) !== 0);
  const savedLog = () => {
    if (argv.length !== 1) return false;   // `< file` would drop the command's other arguments
    try {
      const st = statSync(argv[0]);
      return st.isFile() && !runnable(st);
    } catch { return false; }
  };
  const shellArg = (s) => (/^[\w./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
  const PLAINLY = {
    ENOENT: "command not found",
    EACCES: "permission denied",
    EPERM: "permission denied",
    ENOEXEC: "not executable — no shebang, or built for another architecture",
    // Windows decides how to run a file from its extension rather than a shebang, and
    // libuv reports a file it cannot run as EFTYPE where POSIX would say ENOEXEC.
    EFTYPE: "not an executable file",
    EISDIR: "is a directory",
    ENOTDIR: "is not a directory",
    E2BIG: "argument list too long",
    ENAMETOOLONG: "name too long",
  };
  const startFailed = (e) => {
    const plain = PLAINLY[e.code];
    // node rejects an empty name before it ever reaches the kernel, so there is no errno
    // for it and nothing to name either.
    const said = !argv[0] ? "no command given"
      : plain ? `${argv[0]}: ${plain} (${e.code})`
      : e.message.includes(argv[0]) ? e.message
      : `spawn ${argv[0]} ${e.code ?? e.message}`;
    process.stderr.write(`whatbroke: ${said}\n`);
    if (savedLog()) {
      process.stderr.write(`whatbroke: ${argv[0]} is a file, not a command — to distil it: whatbroke < ${shellArg(argv[0])}\n`);
    }
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
    const tee = (d) => capture.push(d);
    relay(child.stdout, process.stdout, { suppress: quiet, tee });
    // Keep diagnostics visible on stderr while JSON remains clean on stdout.
    relay(child.stderr, process.stderr, { suppress: quiet && !json, tee });
    child.on("error", startFailed);
    child.on("close", (code, signal) => {
      if (code === 0 && !json) {
        // A successful command clears the previous failure baseline.
        if (sinceLast) track(null, capture.finish().truncated, null, 0);
        process.exitCode = 0;
        return;
      }
      const signalCode = signal ? 128 + (osConstants.signals?.[signal] ?? 1) : null;
      const { text, truncated, lines } = capture.finish();
      report(text, code ?? signalCode ?? 1, truncated, null, lines, signal);
    });
  }
}
