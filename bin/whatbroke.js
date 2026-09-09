#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createRequire } from "node:module";
import { constants as osConstants } from "node:os";
import { analyse } from "../src/index.js";
import { render, setColor } from "../src/render.js";
import { normTitle } from "../src/cluster.js";
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

function annotation(f) {
  const params = [];
  if (f.file) params.push(`file=${escapeAnnotation(f.file)}`);
  if (f.line) params.push(`line=${f.line}`);
  if (f.col) params.push(`col=${f.col}`);
  if (f.title) params.push(`title=${escapeAnnotation(f.title)}`);
  const message = escapeData(f.message ?? f.stmt ?? "Command failed");
  return `::error${params.length ? ` ${params.join(",")}` : ""}::${message}`;
}

// The step summary is the one screen a human actually reads in CI, so it leads with
// causes exactly like the terminal does. Annotations stay one per failure - each is a
// marker on a line in the diff view, and dropping one hides a line - so nothing here
// removes information, it only decides what sits above the fold.
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
      others: r?.others ?? null,
      exitCode: code,
      truncated,
      error: executionError,
      failures: r?.failures ?? [],
    };
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  } else if (githubActions && r) {
    for (const f of r.failures) process.stdout.write(`${annotation(f)}\n`);
    // the notice is the line shown at the top of the run - it says causes, not just count
    const causes = (r.clusters ?? []).filter((c) => c.reported);
    const sites = causes.reduce((n, c) => n + c.size, 0);
    const lead = [r.summary, causes.length &&
      `${causes.length} likely cause${causes.length > 1 ? "s" : ""}, ${sites} site${sites > 1 ? "s" : ""}`]
      .filter(Boolean).join(" \u2014 ");
    if (lead) process.stdout.write(`::notice title=whatbroke::${escapeData(lead)}\n`);
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
    const signalCode = signal ? 128 + (osConstants.signals?.[signal] ?? 1) : null;
    report(buf, code ?? signalCode ?? 1, truncated);
  });
}
