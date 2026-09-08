#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createRequire } from "node:module";
import { analyse } from "../src/index.js";
import { render, setColor } from "../src/render.js";
const { version } = createRequire(import.meta.url)("../package.json");

const argv = process.argv.slice(2);
const HELP = `whatbroke — you ran a command, it printed 400 lines. these are the ones that matter.

  whatbroke <command...>     run it, then distil the failure
  whatbroke -q <command...>  hide the command's own output; show only the distillation
  <command> |& whatbroke     distil output piped in

  -q, --quiet   suppress the wrapped command's output
  -a, --all     don't cap the number of failures shown
      --no-source  don't read source files for context
      --no-cluster don't group failures that share a likely cause
      --max-bytes N  cap captured command output (default: 10485760)
  -j, --json    machine-readable output (same as --format json)
  -g, --github-actions  clickable GitHub Actions annotations (same as --format github)
      --format  terminal, json, or github
  -v, --version print the installed version
  -h, --help
`;

const flags = new Set();
let format;
let maxBytes = 10 * 1024 * 1024;
let parseError;
while (argv.length && /^-/.test(argv[0])) {
  const a = argv.shift();
  if (a === "--") break;
  if (a === "--max-bytes") {
    const value = argv.shift();
    maxBytes = Number(value);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024) {
      parseError = "--max-bytes must be an integer of at least 1024";
      break;
    }
    continue;
  }
  if (a.startsWith("--max-bytes=")) {
    maxBytes = Number(a.slice("--max-bytes=".length));
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024) {
      parseError = "--max-bytes must be an integer of at least 1024";
      break;
    }
    continue;
  }
  if (a === "--format") {
    format = argv.shift();
    if (!format || format.startsWith("-")) {
      parseError = "--format requires terminal, json, or github";
      break;
    }
    continue;
  }
  if (a.startsWith("--format=")) {
    format = a.slice("--format=".length);
    continue;
  }
  for (const f of a.startsWith("--") ? [a] : a.slice(1).split("").map((c) => "-" + c)) flags.add(f);
}
const has = (...names) => names.some((n) => flags.has(n));
if (has("-h", "--help")) { process.stdout.write(HELP); process.exit(0); }
if (has("-v", "--version")) { process.stdout.write(`${version}\n`); process.exit(0); }
if (parseError) {
  process.stderr.write(`whatbroke: ${parseError}\n`);
  process.exit(2);
}
format ??= has("-j", "--json") ? "json" : has("-g", "--github-actions") ? "github" : "terminal";
if (!["terminal", "json", "github"].includes(format)) {
  process.stderr.write(`whatbroke: unknown format "${format}" (expected terminal, json, or github)\n`);
  process.exit(2);
}

const color = !process.env.NO_COLOR && process.stdout.isTTY;
setColor(color);
const json = format === "json";
const githubActions = format === "github";
const noSource = has("--no-source");
const noCluster = has("--no-cluster");
// JSON stdout must remain valid even when the wrapped command writes to stdout.
const quiet = has("-q", "--quiet") || json;
const opts = { max: has("-a", "--all") ? Infinity : 5 };

const escapeAnnotation = (value) => String(value)
  .replace(/%/g, "%25")
  .replace(/\r/g, "%0D")
  .replace(/\n/g, "%0A")
  .replace(/:/g, "%3A")
  .replace(/,/g, "%2C");

function annotation(f) {
  const params = [];
  if (f.file) params.push(`file=${escapeAnnotation(f.file)}`);
  if (f.line) params.push(`line=${f.line}`);
  if (f.col) params.push(`col=${f.col}`);
  if (f.title) params.push(`title=${escapeAnnotation(f.title)}`);
  const message = escapeAnnotation(f.message ?? f.stmt ?? "Command failed");
  return `::error${params.length ? ` ${params.join(",")}` : ""}::${message}`;
}

function writeGithubSummary(result, truncated) {
  const target = process.env.GITHUB_STEP_SUMMARY;
  if (!target || !result) return;
  const markdown = (value) => String(value)
    .replace(/\\/g, "\\\\")
    .replace(/([`*_{}\[\]()#+\-.!|>])/g, "\\$1")
    .replace(/\r?\n/g, " ");
  const lines = [`## whatbroke`, "", result.summary ? `**${markdown(result.summary)}**` : ""];
  for (const f of result.failures) {
    const location = f.file ? ` [${markdown(f.file)}${f.line ? `:${f.line}` : ""}]` : "";
    lines.push(`- **${markdown(f.title || "failure")}**${location}: ${markdown(String(f.message ?? f.stmt ?? "").split("\n")[0])}`);
  }
  if (truncated) lines.push("", "> Output capture limit reached. Increase `--max-bytes` for complete diagnostics.");
  appendFileSync(target, `${lines.join("\n")}\n`);
}

function report(raw, code, truncated = false, executionError = null) {
  const r = analyse(raw, { cluster: !noCluster });
  if (json) {
    // Keep the machine-readable envelope stable even when no parser matches.
    const payload = {
      version: 1,
      tool: r?.tool ?? null,
      summary: r?.summary ?? null,
      guessed: r?.guessed ?? false,
      clusters: r?.clusters ?? null,
      exitCode: code,
      truncated,
      error: executionError,
      failures: r?.failures ?? [],
    };
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  } else if (githubActions && r) {
    for (const f of r.failures) process.stdout.write(`${annotation(f)}\n`);
    if (r.summary) process.stdout.write(`::notice title=whatbroke::${r.summary}\n`);
    writeGithubSummary(r, truncated);
  } else if (r) {
    process.stdout.write("\n" + render(r, { ...opts, source: !noSource, cluster: !noCluster }));
    if (truncated) {
      const warning = "  ! output capture limit reached; increase --max-bytes for complete diagnostics";
      process.stdout.write(`\n${process.stdout.isTTY ? `\x1b[33m${warning}\x1b[0m` : warning}\n`);
    }
  } else if (quiet) {
    process.stdout.write(raw);
    if (truncated) {
      process.stdout.write("\nwhatbroke: output capture limit reached; increase --max-bytes for complete diagnostics\n");
    }
  }
  process.exit(code);
}

if (argv.length === 0) {
  if (process.stdin.isTTY) { process.stdout.write(HELP); process.exit(0); }
  let buf = "";
  let bytes = 0;
  let truncated = false;
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => {
    if (bytes >= maxBytes) { truncated = true; return; }
    const remaining = maxBytes - bytes;
    if (Buffer.byteLength(d) > remaining) {
      buf += Buffer.from(d).subarray(0, remaining).toString();
      bytes = maxBytes;
      truncated = true;
    } else {
      buf += d;
      bytes += Buffer.byteLength(d);
    }
  });
  process.stdin.on("end", () => report(buf, 0, truncated));
} else {
  const child = spawn(argv[0], argv.slice(1), { stdio: ["inherit", "pipe", "pipe"] });
  let buf = "";
  let bytes = 0;
  let truncated = false;
  const tap = (stream, out, suppress) => {
    stream.setEncoding("utf8");
    stream.on("data", (d) => {
      if (!suppress) out.write(d);
      if (bytes >= maxBytes) { truncated = true; return; }
      const remaining = maxBytes - bytes;
      const size = Buffer.byteLength(d);
      if (size > remaining) {
        buf += Buffer.from(d).subarray(0, remaining).toString();
        bytes = maxBytes;
        truncated = true;
      } else {
        buf += d;
        bytes += size;
      }
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
    if (code === 0 && !json) process.exit(0);
    const signalCode = signal ? 128 + ({ SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGTERM: 15 }[signal] ?? 1) : null;
    report(buf, code ?? signalCode ?? 1, truncated);
  });
}
