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
import { render, setColor } from "../src/render.js";
import { normTitle } from "../src/cluster.js";
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

// The runner unescapes only these three in a message body. Escaping a colon there
// too leaves "AssertionError%3A expected 1" on screen, so : and , are escaped in
// property values only - where the , and :: separators genuinely need it.
const escapeData = (value) => String(value)
  .replace(/%/g, "%25")
  .replace(/\r/g, "%0D")
  .replace(/\n/g, "%0A");
const escapeAnnotation = (value) => escapeData(value)
  .replace(/:/g, "%3A")
  .replace(/,/g, "%2C");

function annotation(f, tool) {
  const params = [];
  if (f.file) params.push(`file=${escapeAnnotation(f.file)}`);
  if (f.line) params.push(`line=${f.line}`);
  if (f.col) params.push(`col=${f.col}`);
  // Name the producing tool when it is not the one that owns the log, so a reader can
  // tell an eslint marker from a jest one at a glance.
  const label = [tool, f.title].filter(Boolean).join(" ");
  if (label) params.push(`title=${escapeAnnotation(label)}`);
  const message = escapeData(f.message ?? f.stmt ?? "Command failed");
  return `::error${params.length ? ` ${params.join(",")}` : ""}::${message}`;
}

// The step summary is the one screen a human actually reads in CI, so it leads with
// causes exactly like the terminal does. Annotations stay one per failure - each is a
// marker on a line in the diff view, and dropping one hides a line - so nothing here
// removes information, it only decides what sits above the fold.
function appendGithubSummary(text) {
  const target = process.env.GITHUB_STEP_SUMMARY;
  if (!target) return;
  try { appendFileSync(target, text); }
  catch (error) { process.stderr.write(`whatbroke: could not write GitHub summary: ${error.message}\n`); }
}

function writeGithubSummary(result, truncated) {
  const target = process.env.GITHUB_STEP_SUMMARY;
  if (!target || !result) return;
  const markdown = (value) => String(value)
    .replace(/\\/g, "\\\\")
    .replace(/([`*_{}\[\]()#+\-.!|<>])/g, "\\$1")
    .replace(/\r?\n/g, " ");
  // A code span needs no escaping and must not receive any. It must also not contain
  // a backtick, or the span closes early and the rest of the path becomes markup.
  const code = (value) => "`" + String(value).replace(/[`\r\n]/g, " ").trim() + "`";
  const fails = result.failures;
  const at = (f) => (f.file ? `${f.file}${f.line ? `:${f.line}` : ""}` : (f.title || "?"));
  const head = (f) => markdown(String(f.message ?? f.stmt ?? "").split("\n")[0]);
  const plural = (n, word) => `${n} ${word}${n > 1 ? "s" : ""}`;

  // Same fallback as the terminal: with clustering off this is the old flat list.
  const units = result.clusters
    ?? fails.map((_, i) => ({ size: 1, members: [i], exemplar: i, reported: false }));
  const reported = units.filter((u) => u.reported);

  const lines = ["## whatbroke", ""];
  if (result.summary) lines.push(`**${markdown(result.summary)}**`, "");
  if (reported.length) {
    const sites = reported.reduce((n, u) => n + u.size, 0);
    const others = fails.length - sites;
    lines.push(`**${plural(reported.length, "likely cause")}, ${plural(sites, "site")}` +
               `${others ? ` (+${plural(others, "other")})` : ""}**`, "");
  }

  reported.forEach((u, n) => {
    const f = fails[u.exemplar];
    // one parametrized family reads as "N cases", not "N sites" - as in the terminal
    const family = u.members.every((i) => normTitle(fails[i].title) === normTitle(f.title));
    lines.push(`### ${n + 1}. ${markdown((family ? normTitle(f.title) : f.title) || "failure")}`, "");
    lines.push(`${code(at(f))} — ${head(f)}`, "");
    // Parametrized cases share a source line, so the member count and the number of
    // distinct places differ. Label the disclosure with what is actually inside it -
    // "6 sites" above a list of three is the tool contradicting its own evidence.
    const sites = [...new Set(u.members.map((i) => at(fails[i])))];
    const label = sites.length === u.size
      ? plural(u.size, family ? "case" : "site")
      : `${plural(u.size, "case")} at ${plural(sites.length, "site")}`;
    lines.push(`<details><summary>${label}</summary>`, "");
    for (const s of sites) lines.push(`- ${code(s)}`);
    lines.push("", "</details>", "");
  });

  const rest = units.filter((u) => !u.reported).map((u) => u.exemplar);
  if (rest.length) {
    if (reported.length) lines.push("### Other failures", "");
    const body = rest.map((i) => `- **${markdown(fails[i].title || "failure")}**` +
      `${fails[i].file ? ` ${code(at(fails[i]))}` : ""}: ${head(fails[i])}`);
    // A long ungrouped tail buries the causes above it. Fold it, never drop it: the
    // summary stays a complete account of everything that failed.
    if (body.length > 10) lines.push(`<details><summary>${body.length} more</summary>`, "", ...body, "", "</details>", "");
    else lines.push(...body, "");
  }

  // A second tool's failures are not a footnote. Give each one its own section rather
  // than a count the reader has to go back to the raw log to act on.
  for (const other of result.others ?? []) {
    if (!other.failures?.length) continue;
    lines.push(`### ${markdown(other.tool)} — ${plural(other.failures.length, "failure")}`, "");
    const body = other.failures.map((f) => `- **${markdown(f.title || "failure")}**` +
      `${f.file ? ` ${code(at(f))}` : ""}: ${head(f)}`);
    if (body.length > 10) lines.push(`<details><summary>${body.length} more</summary>`, "", ...body, "", "</details>", "");
    else lines.push(...body, "");
  }

  if (truncated) lines.push("", "> Output capture limit reached. Increase `--max-bytes` for complete diagnostics.");
  appendGithubSummary(`${lines.join("\n")}\n`);
}

const truncationNotice = "output capture limit reached; captured output is incomplete (increase --max-bytes)";

// Bound the encoded preview too: newlines/percent signs expand during escaping,
// and Unicode characters can occupy several bytes. Never split an escape or code point.
function capturedOutputAnnotation(raw) {
  const prefix = "::notice title=whatbroke captured output::";
  const suffix = " [preview truncated; use --json for full captured output]";
  const budget = 3500 - Buffer.byteLength(prefix + suffix + "\n");
  let preview = "", bytes = 0;
  for (const char of raw) {
    const escaped = escapeData(char);
    const size = Buffer.byteLength(escaped);
    if (bytes + size > budget) return prefix + preview + suffix + "\n";
    preview += escaped;
    bytes += size;
  }
  return prefix + preview + "\n";
}

function writeFallback(fallback, truncated, executionError) {
  const piped = inputMode === "pipe";
  const explanation = executionError ?? "whatbroke could not identify a diagnostic.";
  const raw = fallback.rawOutput;
  if (githubActions) {
    // Unknown upstream status is a notice, not an invented failed command.
    const level = piped ? "notice" : "error";
    process.stdout.write(`::${level} title=whatbroke::${escapeData(fallback.message + "\n" + explanation)}\n`);
    if (raw && (piped || quiet)) {
      // Escaped annotation data keeps raw workflow-command syntax inert.
      process.stdout.write(capturedOutputAnnotation(raw));
    } else if (!raw) {
      process.stdout.write("::notice title=whatbroke::No output was captured.\n");
    }
    if (truncated) process.stdout.write(`::warning title=whatbroke::${truncationNotice}\n`);

    const context = executionError ?? (raw || "No output was captured.");
    // A log may itself contain fenced Markdown. Use a longer fence so its text
    // stays inside the code block in the job summary.
    let fenceLength = 3;
    for (const match of context.matchAll(/`+/g)) fenceLength = Math.max(fenceLength, match[0].length + 1);
    const fence = "`".repeat(fenceLength);
    appendGithubSummary(["## whatbroke", "", fallback.message, "",
      executionError ? "Launch error:" : "Captured output:", "", fence, context, fence, "",
      ...(truncated ? [`> ${truncationNotice}`, ""] : []),
    ].join("\n"));
  } else {
    process.stdout.write(`\n${fallback.message}\n${explanation}\n`);
    if (!raw) process.stdout.write("No output was captured.\n");
    else if (piped || quiet) process.stdout.write(`\nCaptured output:\n${raw}${raw.endsWith("\n") ? "" : "\n"}`);
    else process.stdout.write("Raw command output was streamed above.\n");
    if (truncated) process.stdout.write(`\nwhatbroke: ${truncationNotice}\n`);
  }
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
function report(raw, code, truncated = false, executionError = null) {
  // Spawn errors are followed by a close event. Emit exactly one result while
  // allowing stdout to drain instead of cutting off a large JSON/raw fallback.
  if (reported) return;
  reported = true;
  // argv is what the user actually ran; it is evidence for detection, not decoration.
  const r = analyse(raw, { cluster: !noCluster, command: inputMode === "command" ? argv : null });
  const since = sinceLast ? track(r, truncated, executionError) : null;
  const fallback = !r && (code !== 0 || (inputMode === "pipe" && raw.length > 0)) ? {
    reason: executionError ? "spawn-error" : raw.length ? "unrecognized-output" : "no-output",
    message: executionError ? `Command could not be started (exit code ${code}).`
      : inputMode === "pipe" ? "Unrecognized input. Upstream command exit status is unknown."
      : `Command failed with exit code ${code}.`,
    rawOutput: raw,
  } : null;
  if (json) {
    // Keep the machine-readable envelope stable even when no parser matches.
    const payload = {
      version: 1,
      tool: r?.tool ?? null,
      summary: r?.summary ?? null,
      guessed: r?.guessed ?? false,
      clusters: r?.clusters ?? null,
      others: r?.others ?? null,
      exitCode: code,
      inputMode,
      commandExitCode: inputMode === "command" && !executionError ? code : null,
      fallback,
      truncated,
      error: executionError,
      since,
      failures: r?.failures ?? [],
    };
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  } else if (githubActions && r) {
    // Every failure in the log gets a marker, including the ones a second tool found.
    // A lint error on line 12 is no less real for arriving in the same log as the tests.
    for (const f of r.failures) process.stdout.write(`${annotation(f)}\n`);
    for (const other of r.others ?? []) {
      for (const f of other.failures ?? []) process.stdout.write(`${annotation(f, other.tool)}\n`);
    }
    // the notice is the line shown at the top of the run - it says causes, not just count
    const causes = (r.clusters ?? []).filter((c) => c.reported);
    const sites = causes.reduce((n, c) => n + c.size, 0);
    const lead = [r.summary, causes.length &&
      `${causes.length} likely cause${causes.length > 1 ? "s" : ""}, ${sites} site${sites > 1 ? "s" : ""}`,
      since?.compared && `${since.fresh.length} new since the last tracked run`]
      .filter(Boolean).join(" \u2014 ");
    if (lead) process.stdout.write(`::notice title=whatbroke::${escapeData(lead)}\n`);
    writeGithubSummary(r, truncated);
  } else if (r) {
    process.stdout.write("\n" + render(r, { ...opts, source: !noSource, cluster: !noCluster, since }));
    if (truncated) {
      const warning = "  ! output capture limit reached; increase --max-bytes for complete diagnostics";
      process.stdout.write(`\n${process.stdout.isTTY ? `\x1b[33m${warning}\x1b[0m` : warning}\n`);
    }
  } else if (fallback) writeFallback(fallback, truncated, executionError);
  process.exitCode = code;
}

if (argv.length === 0) {
  if (process.stdin.isTTY) { process.stdout.write(HELP); process.exit(0); }
  // No setEncoding: decoding each chunk and re-encoding it to measure bytes is what
  // used to split multi-byte characters at the cap. Buffers in, one decode at the end.
  const capture = createCapture(maxBytes);
  process.stdin.on("data", (d) => capture.push(d));
  process.stdin.on("end", () => {
    const { text, truncated } = capture.finish();
    report(text, 0, truncated);
  });
} else {
  const child = spawn(argv[0], argv.slice(1), { stdio: ["inherit", "pipe", "pipe"] });
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
  child.on("error", (e) => {
    process.stderr.write(`whatbroke: ${e.message}\n`);
    report("", 127, false, e.message);
  });
  child.on("close", (code, signal) => {
    if (code === 0 && !json) { process.exitCode = 0; return; }
    const signalCode = signal ? 128 + (osConstants.signals?.[signal] ?? 1) : null;
    const { text, truncated } = capture.finish();
    report(text, code ?? signalCode ?? 1, truncated);
  });
}
