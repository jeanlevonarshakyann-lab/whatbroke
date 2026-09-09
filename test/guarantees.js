// The two promises everything else is subordinate to.
//
//   1. The exit code whatbroke returns is the one the command returned.
//   2. A command that failed is never presented as anything else.
//
// Both were true when this file was written; neither was pinned, so any change to the
// capture path, the fallback path, or an output format could quietly break them and
// every other test would still pass. A tool that reports success for a failed command
// is worse than no tool, because it is believed.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "bin", "whatbroke.js");

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
};

const cache = mkdtempSync(join(tmpdir(), "wb-guarantee-"));
const MODES = [[], ["--json"], ["--format", "github"], ["-q"], ["--since-last"], ["--no-cluster"], ["--all"]];
const run = (args) => spawnSync(process.execPath, [cli, ...args], {
  encoding: "utf8", timeout: 20000,
  env: { ...process.env, NO_COLOR: "1", GITHUB_STEP_SUMMARY: "", WHATBROKE_CACHE_DIR: cache },
});

// ------------------------------------------------------------- exit codes

test("the exit code is the command's own, in every output mode", () => {
  const cases = [
    [["node", "-e", "process.exit(0)"], 0, "success"],
    [["node", "-e", "process.exit(1)"], 1, "exit 1"],
    [["node", "-e", "process.exit(3)"], 3, "exit 3"],
    [["node", "-e", "process.exit(42)"], 42, "an unusual code"],
    [["definitely-not-a-binary-xyz"], 127, "command not found"],
  ];
  const wrong = [];
  for (const [command, want, label] of cases) {
    for (const mode of MODES) {
      const r = run([...mode, ...command]);
      if (r.status !== want) wrong.push(`${label} under ${JSON.stringify(mode)}: want ${want}, got ${r.status}`);
    }
  }
  assert.deepEqual(wrong, []);
});

test("a signal becomes the shell's code for that signal", () => {
  for (const [signal, want] of [["SIGKILL", 137], ["SIGTERM", 143]]) {
    for (const mode of MODES) {
      const r = run([...mode, "node", "-e", `process.kill(process.pid, "${signal}")`]);
      assert.equal(r.status, want, `${signal} under ${JSON.stringify(mode)}`);
    }
  }
});

// --------------------------------------------------- never hide a failure

test("a failed command is never presented as anything else", () => {
  // Including when its output says the opposite, or when there is no output to read.
  const outputs = {
    "no output at all": "",
    "only whitespace": "   \n\n\t\n",
    "text claiming success": "All tests passed!\nBuild succeeded.\nDone in 2.1s",
    "PASS lines and a green tally": "PASS src/a.test.js\nPASS src/b.test.js\nTests: 12 passed",
    "output no parser understands": "zork frobnicate 42\nquux",
    "a real diagnostic": "bad.ts(2,52): error TS2551: Property x does not exist.",
    "nothing but colour codes": "[32m[0m",
  };
  const silent = [];
  for (const [what, out] of Object.entries(outputs)) {
    for (const mode of [[], ["-q"], ["--format", "github"], ["--json"]]) {
      const r = run([...mode, "node", "-e",
        `process.stdout.write(${JSON.stringify(out)}); process.exit(1)`]);
      assert.equal(r.status, 1, `${what} under ${JSON.stringify(mode)}: exit code lost`);
      const said = /failed|error|✗|::error|could not identify|exit code|"exitCode": 1/i.test(r.stdout + r.stderr);
      if (!said) silent.push(`${what} under ${JSON.stringify(mode)}: ${JSON.stringify((r.stdout + r.stderr).slice(0, 60))}`);
    }
  }
  assert.deepEqual(silent, [], "whatbroke said nothing about a command that failed");
});

test("a successful command is left alone", () => {
  // The mirror of the rule above: inventing a failure is its own kind of lie.
  for (const mode of [[], ["-q"], ["--format", "github"]]) {
    const r = run([...mode, "node", "-e", "console.log('everything is fine'); process.exit(0)"]);
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stdout, /✗|::error|could not identify/, `invented a failure under ${JSON.stringify(mode)}`);
  }
});

test("JSON always says what the command did, parsed or not", () => {
  for (const out of ["", "zork frobnicate", "bad.ts(2,52): error TS2551: x"]) {
    const r = run(["--json", "node", "-e", `process.stdout.write(${JSON.stringify(out)}); process.exit(7)`]);
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.exitCode, 7);
    assert.equal(payload.commandExitCode, 7);
    assert.equal(r.status, 7);
    // empty `failures` must never be readable as "nothing was wrong"
    if (!payload.failures.length) assert.ok(payload.fallback, "no failures and no fallback is indistinguishable from success");
  }
});

rmSync(cache, { recursive: true, force: true });
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
