// The command line: its JSON, GitHub Actions output, options and exit codes.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { analyse } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n) => readFileSync(join(here, "fixtures", n), "utf8");
const cli = join(here, "..", "bin", "whatbroke.js");

let pass = 0, fail = 0;


// JSON is a stable automation interface, including the wrapped command's exit code.
try {
  const r = spawnSync(process.execPath, [cli, "--json", "node", "-e",
    "try { null.x } catch (e) { console.error(e.stack); process.exit(3) }"], { encoding: "utf8" });
  assert.equal(r.status, 3);
  const json = JSON.parse(r.stdout);
  assert.equal(json.version, 1);
  assert.equal(json.tool, "node");
  assert.equal(json.exitCode, 3);
  assert.equal(json.truncated, false);
  assert.ok(Array.isArray(json.failures));
  assert.equal(r.stderr.includes("TypeError"), true);
  assert.equal(r.stdout.startsWith("{"), true);
  console.log("  ok   JSON output has a stable envelope and preserves exit code");
  pass++;
} catch (e) { console.log(`  FAIL JSON output\n       ${e.message}`); fail++; }

try {
  const r = spawnSync(process.execPath, [cli, "--format", "json", "--max-bytes", "1024",
    "node", "-e", "console.error('x'.repeat(5000)); process.exit(1)"], { encoding: "utf8" });
  assert.equal(r.status, 1);
  const json = JSON.parse(r.stdout);
  assert.equal(json.truncated, true);
  console.log("  ok   large output is bounded and reports truncation");
  pass++;
} catch (e) { console.log(`  FAIL bounded output\n       ${e.message}`); fail++; }

try {
  const r = spawnSync(process.execPath, [cli, "--quiet", "--max-bytes", "1024",
    "node", "-e", "console.error('x'.repeat(5000)); process.exit(1)"], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /output capture limit reached/);
  console.log("  ok   terminal output reports truncation");
  pass++;
} catch (e) { console.log(`  FAIL terminal truncation\n       ${e.message}`); fail++; }

try {
  const r = spawnSync(process.execPath, [cli, "--github-actions", "node", "-e",
    "try { null.x } catch (e) { console.error(e.stack); process.exit(1) }"], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /::error file=\[eval\],line=1,col=12,title=TypeError::/);
  console.log("  ok   GitHub Actions output contains clickable annotations");
  pass++;
} catch (e) { console.log(`  FAIL GitHub Actions output\n       ${e.message}`); fail++; }

try {
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "whatbroke-summary-"));
  const summary = join(dir, "summary.md");
  const r = spawnSync(process.execPath, [cli, "--github-actions", "node", "-e",
    "null.x"], { encoding: "utf8", env: { ...process.env, GITHUB_STEP_SUMMARY: summary } });
  assert.equal(r.status, 1);
  assert.match(readFileSync(summary, "utf8"), /## whatbroke/);
  assert.ok(!/[^\n]\\\*/.test(readFileSync(summary, "utf8")), "summary should remain valid markdown");
  rmSync(dir, { recursive: true, force: true });
  console.log("  ok   GitHub Actions summary is written");
  pass++;
} catch (e) { console.log(`  FAIL GitHub Actions summary\n       ${e.message}`); fail++; }

// The step summary is what a human reads in CI, so it leads with causes like the
// terminal does - while the annotations below it stay one per failure, because each
// one is a marker on a line and dropping one hides a line.
try {
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "whatbroke-cluster-summary-"));
  const summary = join(dir, "summary.md");
  const raw = fx("eslint_bulk_fail.txt");
  const r = spawnSync(process.execPath, [cli, "--format", "github"], {
    input: raw, encoding: "utf8", env: { ...process.env, GITHUB_STEP_SUMMARY: summary },
  });
  const md = readFileSync(summary, "utf8");
  const analysed = analyse(raw);
  const causes = analysed.clusters.filter((c) => c.reported);
  assert.ok(causes.length >= 2, "fixture must actually cluster for this test to mean anything");
  assert.match(md, new RegExp(`\\*\\*${causes.length} likely causes, \\d+ sites`),
    "summary must lead with the cause count");
  assert.match(md, /^### 1\. /m, "each cause gets its own section");
  assert.match(md, /<details><summary>\d+ (?:case|site)s<\/summary>/, "sites are folded, not listed flat");
  // nothing is hidden: every failure still reaches the summary and the annotations
  for (const f of analysed.failures) assert.ok(md.includes(`${f.file}:${f.line}`), `${f.file}:${f.line} missing`);
  assert.equal((r.stdout.match(/^::error /gm) ?? []).length, analysed.failures.length);
  assert.match(r.stdout, /^::notice title=whatbroke::.* likely causes, \d+ sites$/m);
  rmSync(dir, { recursive: true, force: true });
  console.log("  ok   GitHub summary leads with clusters and hides nothing");
  pass++;
} catch (e) { console.log(`  FAIL GitHub clustered summary\n       ${e.message}`); fail++; }

// A disclosure that says "6 sites" over a list of three is the tool contradicting its
// own evidence, which is the one thing clustering must never do. Members and distinct
// places diverge whenever parametrized cases share a source line.
try {
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "whatbroke-labels-"));
  let checked = 0;
  for (const name of readdirSync(join(here, "fixtures"))) {
    const summary = join(dir, `${name}.md`);
    spawnSync(process.execPath, [cli, "--format", "github"], {
      input: fx(name), encoding: "utf8", env: { ...process.env, GITHUB_STEP_SUMMARY: summary },
    });
    const md = readFileSync(summary, "utf8");
    for (const [, label, body] of md.matchAll(/<details><summary>(.*?)<\/summary>\n(.*?)<\/details>/gs)) {
      const listed = body.split("\n").filter((l) => l.startsWith("- ")).length;
      const claimed = Number((label.match(/\d+/g) ?? []).at(-1));
      assert.equal(claimed, listed, `"${label}" in ${name} sits above ${listed} entries`);
      checked++;
    }
  }
  assert.ok(checked > 5, "the corpus must actually produce disclosures for this to test anything");
  rmSync(dir, { recursive: true, force: true });
  console.log(`  ok   every GitHub summary disclosure counts what it lists (${checked} checked)`);
  pass++;
} catch (e) { console.log(`  FAIL GitHub summary disclosure counts\n       ${e.message}`); fail++; }

// A workflow command unescapes only %25/%0D/%0A in a message body, so escaping a
// colon there leaves "KeyError%3A 'exp'" on screen. Property values still need it.
try {
  const r = spawnSync(process.execPath, [cli, "--format", "github"], {
    input: fx("pytest_fail.txt"), encoding: "utf8",
    env: { ...process.env, GITHUB_STEP_SUMMARY: "" },
  });
  const errors = r.stdout.match(/^::error .*$/gm) ?? [];
  assert.ok(errors.some((l) => l.endsWith("::KeyError: 'exp'")), "message colons stay literal");
  for (const line of errors) {
    const [props, ...rest] = line.slice("::error ".length).split("::");
    assert.doesNotMatch(rest.join("::"), /%3A|%2C/, "message must not carry property escapes");
    // a raw comma or colon inside a value would be read as the next property, or as
    // the end of the property block - so those two stay escaped here
    for (const prop of props.split(",")) {
      assert.doesNotMatch(prop.slice(prop.indexOf("=") + 1), /[:,]/, "property values must stay escaped");
    }
  }
  console.log("  ok   annotation messages keep colons that property values escape");
  pass++;
} catch (e) { console.log(`  FAIL annotation escaping\n       ${e.message}`); fail++; }

try {
  const r = spawnSync(process.execPath, [cli, "--quiet", "--max-bytes", "1024",
    "node", "-e", "console.error('x'.repeat(5000)); process.exit(1)"], { encoding: "utf8" });
  assert.ok(!/\x1b\[33m/.test(r.stdout), "non-TTY output must not contain ANSI color codes");
  console.log("  ok   non-TTY truncation warning stays plain text");
  pass++;
} catch (e) { console.log(`  FAIL non-TTY truncation\n       ${e.message}`); fail++; }

try {
  const r = spawnSync(process.execPath, [cli, "--format=json", "node", "-e",
    "console.log('must not corrupt stdout'); process.exit(4)"], { encoding: "utf8" });
  assert.equal(r.status, 4);
  const json = JSON.parse(r.stdout);
  assert.equal(json.version, 1);
  assert.equal(json.exitCode, 4);
  console.log("  ok   explicit format selector keeps JSON valid");
  pass++;
} catch (e) { console.log(`  FAIL format selector\n       ${e.message}`); fail++; }

try {
  const r = spawnSync(process.execPath, [cli, "--format", "invalid"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown format/);
  console.log("  ok   invalid format is rejected clearly");
  pass++;
} catch (e) { console.log(`  FAIL invalid format\n       ${e.message}`); fail++; }

try {
  const r = spawnSync(process.execPath, [cli, "--no-source", "node", "-e",
    "null.x"], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /Cannot read properties of null/);
  assert.match(r.stdout, /\[eval\]:1/);
  assert.match(r.stdout, /│ null\.x/, "statements captured in the log must remain visible");
  console.log("  ok   no-source mode avoids reading source context");
  pass++;
} catch (e) { console.log(`  FAIL no-source mode\n       ${e.message}`); fail++; }

try {
  const r = spawnSync(process.execPath, [cli, "--format"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--format requires/);
  console.log("  ok   missing format value is rejected clearly");
  pass++;
} catch (e) { console.log(`  FAIL missing format\n       ${e.message}`); fail++; }

try {
  const r = spawnSync(process.execPath, [cli, "--format", "json", "whatbroke-command-does-not-exist"], { encoding: "utf8" });
  assert.equal(r.status, 127);
  assert.match(r.stderr, /whatbroke-command-does-not-exist/);
  const json = JSON.parse(r.stdout);
  assert.equal(json.exitCode, 127);
  assert.match(json.error, /whatbroke-command-does-not-exist/);
  console.log("  ok   command-not-found preserves a distinct 127 failure");
  pass++;
} catch (e) { console.log(`  FAIL command-not-found\n       ${e.message}`); fail++; }

try {
  const r = spawnSync(process.execPath, [cli, "--format", "json", "node", "-e", "process.kill(process.pid, 'SIGTERM')"], { encoding: "utf8" });
  // Windows does not expose POSIX signal termination through child_process;
  // the same command exits with its native status code instead.
  const expectedStatus = process.platform === "win32" ? 1 : 143;
  assert.equal(r.status, expectedStatus);
  const json = JSON.parse(r.stdout);
  assert.equal(json.exitCode, expectedStatus);
  console.log("  ok   signal termination is represented as a shell-compatible exit code");
  pass++;
} catch (e) { console.log(`  FAIL signal termination\n       ${e.message}`); fail++; }

try {
  const r = spawnSync(process.execPath, [cli, "--json", process.execPath, "-e",
    "process.kill(process.pid, 'SIGKILL')"], { encoding: "utf8" });
  const expected = process.platform === "win32" ? 1 : 137;
  assert.equal(r.status, expected);
  assert.equal(JSON.parse(r.stdout).exitCode, expected);
  console.log("  ok   SIGKILL preserves the platform's shell-compatible exit code");
  pass++;
} catch (e) { console.log(`  FAIL SIGKILL exit code\n       ${e.message}`); fail++; }

// A command that is killed writes nothing on the way out, and the number it leaves is all
// there is. Node knows which signal it was; before this, the report threw that away.
try {
  const r = spawnSync(process.execPath, [cli, "--json", process.execPath, "-e",
    "process.kill(process.pid, 'SIGKILL')"], { encoding: "utf8" });
  const { status } = JSON.parse(r.stdout);
  if (process.platform === "win32") {
    // Windows reports no signal, and a bare 1 is every program's way of failing.
    assert.equal(status, null);
  } else {
    assert.equal(status.signal, "SIGKILL");
    assert.equal(status.code, 137);
    assert.match(status.says, /^Killed by SIGKILL\b/);
    assert.match(status.says, /out of memory/);
  }
  console.log("  ok   a killed command reports the signal that killed it");
  pass++;
} catch (e) { console.log(`  FAIL killed command's signal\n       ${e.message}`); fail++; }

try {
  const r = spawnSync(process.execPath, [cli, process.execPath, "-e",
    "process.kill(process.pid, 'SIGKILL')"], { encoding: "utf8" });
  if (process.platform !== "win32") {
    assert.match(r.stdout, /Command failed with exit code 137\./);
    assert.match(r.stdout, /Killed by SIGKILL/);
    // With nothing captured there was no diagnostic to miss, so it does not say there was.
    assert.equal(r.stdout.includes("could not identify a diagnostic"), false);
    assert.match(r.stdout, /No output was captured\./);
  }
  console.log("  ok   the terminal says what the signal was instead of nothing");
  pass++;
} catch (e) { console.log(`  FAIL killed command's terminal output\n       ${e.message}`); fail++; }

// A run killed part-way still read what it got to print, and the reader has to be told
// both: these failures, and that the run did not finish.
try {
  const r = spawnSync(process.execPath, [cli, "-q", process.execPath, "-e",
    "console.log('bad.ts(3,9): error TS2322: Type X is not assignable to type number.'); process.kill(process.pid, 'SIGKILL')"],
    { encoding: "utf8" });
  assert.match(r.stdout, /TS2322/);
  if (process.platform !== "win32") assert.match(r.stdout, /! Killed by SIGKILL/);
  console.log("  ok   a diagnosis and the signal that cut the run short are both reported");
  pass++;
} catch (e) { console.log(`  FAIL diagnosis beside a signal\n       ${e.message}`); fail++; }

// 127 and 126 are a shell's conventions, and the sentence says so rather than asserting
// what happened. Every other number is left alone: 1 and 2 are what every program returns.
try {
  const r = spawnSync(process.execPath, [cli, "--json", process.execPath, "-e",
    "process.exit(127)"], { encoding: "utf8" });
  const { status } = JSON.parse(r.stdout);
  assert.equal(status.signal, null);
  assert.equal(status.code, 127);
  assert.match(status.says, /shell's way of saying the command does not exist/);
  const plain = spawnSync(process.execPath, [cli, "--json", process.execPath, "-e",
    "process.exit(1)"], { encoding: "utf8" });
  assert.equal(JSON.parse(plain.stdout).status, null);
  console.log("  ok   a shell's exit conventions are read as conventions, and no others");
  pass++;
} catch (e) { console.log(`  FAIL exit code conventions\n       ${e.message}`); fail++; }

// A piped log's number belongs to whoever produced it, and whatbroke never saw it.
try {
  const r = spawnSync(process.execPath, [cli, "--json"], { encoding: "utf8", input: "nothing here explains anything\n" });
  const report = JSON.parse(r.stdout);
  assert.equal(report.inputMode, "pipe");
  assert.equal(report.status, null);
  console.log("  ok   a piped log's upstream exit status is not invented");
  pass++;
} catch (e) { console.log(`  FAIL piped status\n       ${e.message}`); fail++; }

try {
  const r = spawnSync(process.execPath, [cli, "--version"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+$/);
  console.log("  ok   version flag reports the package version");
  pass++;
} catch (e) { console.log(`  FAIL version flag\n       ${e.message}`); fail++; }

// ------------------------------------------------ streaming the command's own output

// The copy kept for diagnosis is capped by --max-bytes. The copy streamed to the terminal
// was capped by nothing: write() returns false when the destination cannot take more, and
// ignoring it makes node queue every later chunk in this process's memory. A command that
// prints faster than the terminal, the file or the pipe on the other side can read it then
// grows whatbroke's heap without limit - the one thing --max-bytes exists to prevent.
try {
  const { PassThrough } = await import("node:stream");
  const { relay } = await import("../src/stream.js");
  const source = new PassThrough();
  const seen = [];
  let full = true, drained = null;
  const out = {                                     // a destination that cannot take more
    write: () => !full,
    once: (event, fn) => { if (event === "drain") drained = fn; },
  };
  relay(source, out, { tee: (d) => seen.push(d.toString()) });
  source.write("one");
  assert.equal(source.isPaused(), true, "a full destination stops the stream being read");
  source.write("two");                              // goes nowhere: paused streams emit nothing
  full = false;
  drained();
  assert.equal(source.isPaused(), false, "and draining starts it again");
  source.write("three");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(seen, ["one", "two", "three"], "everything is captured, paused or not");
  console.log("  ok   a stream is paused when its destination is full and resumed when it drains");
  pass++;
} catch (e) { console.log(`  FAIL relay backpressure\n       ${e.message}`); fail++; }

// And end to end: a reader that is not reading must slow the wrapped command down rather
// than be queued up in whatbroke.
try {
  const { mkdtempSync, rmSync, writeFileSync: write } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "wb-stream-"));
  const helper = join(dir, "slow-consumer.mjs");
  const MB = 8;
  write(helper, `
import { spawn } from "node:child_process";
const [cli, code] = process.argv.slice(2);
const child = spawn(process.execPath, [cli, "--", process.execPath, "-e", \`
  const chunk = Buffer.alloc(64 * 1024, 0x61);
  let left = ${MB} * 1024 * 1024;
  const write = () => {
    while (left > 0) {
      left -= chunk.length;
      if (!process.stdout.write(chunk)) return process.stdout.once("drain", write);
    }
    process.stderr.write("WROTE-ALL");
    process.exit(\${code});
  };
  write();
\`], { stdio: ["ignore", "pipe", "pipe"] });
let err = "", bytes = 0;
child.stderr.on("data", (d) => { err += d; });
child.stdout.pause();                    // the slow consumer: nobody is reading yet
setTimeout(() => {
  const ranAhead = err.includes("WROTE-ALL");
  child.stdout.on("data", (d) => { bytes += d.length; });
  child.stdout.resume();
  child.on("close", (status) => process.stdout.write(JSON.stringify({ ranAhead, bytes, status })));
}, 500);
`);
  const green = JSON.parse(spawnSync(process.execPath, [helper, cli, "0"],
    { encoding: "utf8", timeout: 60000 }).stdout);
  assert.equal(green.ranAhead, false,
    "the command was allowed to write 8MB while nothing was reading it");
  assert.equal(green.bytes, MB * 1024 * 1024, "and every streamed byte still arrived");
  assert.equal(green.status, 0);

  const failed = JSON.parse(spawnSync(process.execPath, [helper, cli, "7"],
    { encoding: "utf8", timeout: 60000 }).stdout);
  assert.equal(failed.ranAhead, false);
  assert.ok(failed.bytes >= MB * 1024 * 1024, "the report is printed after the output, not instead of it");
  assert.equal(failed.status, 7, "and the wrapped command's exit code survives");
  rmSync(dir, { recursive: true, force: true });
  console.log("  ok   a slow reader slows the wrapped command instead of filling memory");
  pass++;
} catch (e) { console.log(`  FAIL live streaming backpressure\n       ${e.message}`); fail++; }

const cliResults = await (await import("./cli.js")).runCliTests();
pass += cliResults.pass;
fail += cliResults.fail;

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
