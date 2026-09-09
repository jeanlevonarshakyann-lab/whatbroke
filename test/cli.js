import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Keep CLI contract tests separate from parser fixtures and source-safety tests.
export async function runCliTests(cli = fileURLToPath(new URL("../bin/whatbroke.js", import.meta.url))) {
  let pass = 0, fail = 0;
  const raw = "The operation did not complete.\nSee the attached report.\n";
  const run = (args = [], input = "", env = {}) => {
    const r = spawnSync(process.execPath, [cli, ...args], {
      input, encoding: "utf8", timeout: 20000, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: "1", GITHUB_STEP_SUMMARY: "", ...env },
    });
    assert.ifError(r.error);
    return r;
  };
  const command = (text, code) => [process.execPath, "-e",
    `process.stdout.write(${JSON.stringify(text)}); process.exitCode = ${code}`];
  const check = async (name, fn) => {
    try { await fn(); console.log(`  ok   CLI ${name}`); pass++; }
    catch (error) { console.log(`  FAIL CLI ${name}\n       ${error.message}`); fail++; }
  };

  await check("unrecognized pipes retain raw text and unknown upstream status", () => {
    for (const args of [[], ["-q"], ["--format", "terminal"]]) {
      const r = run(args, raw);
      assert.equal(r.status, 0);
      assert.ok(r.stdout.includes(raw));
      assert.match(r.stdout, /Upstream command exit status is unknown/);
      assert.doesNotMatch(r.stdout, /Command failed|Command succeeded/);
    }
  });

  await check("explicit stdin marker preserves terminal and JSON pipe behavior", () => {
    for (const args of [["-"], ["-q", "-"], ["-", "-q"]]) {
      const r = run(args, raw);
      assert.equal(r.status, 0);
      assert.ok(r.stdout.includes(raw));
    }
    const r = run(["--json", "-"], raw);
    assert.equal(r.status, 0);
    const result = JSON.parse(r.stdout);
    assert.equal(result.inputMode, "pipe");
    assert.equal(result.fallback.rawOutput, raw);
  });

  await check("wrapped unknown failures report status without duplicating streamed output", () => {
    for (const flags of [[], ["-q"]]) {
      const r = run([...flags, ...command(raw, 7)]);
      assert.equal(r.status, 7);
      assert.match(r.stdout, /Command failed with exit code 7/);
      assert.equal(r.stdout.split(raw).length - 1, 1);
    }
  });

  await check("empty failed commands cannot look successful", () => {
    for (const flags of [[], ["-q"], ["--github-actions"]]) {
      const r = run([...flags, ...command("", 9)]);
      assert.equal(r.status, 9);
      assert.match(r.stdout, /Command failed with exit code 9/);
      assert.match(r.stdout, /No output was captured/);
    }
  });

  await check("version-1 JSON exposes unknown pipe status and recoverable raw output", () => {
    const r = run(["--json"], raw);
    assert.equal(r.status, 0);
    const result = JSON.parse(r.stdout);
    assert.equal(result.version, 1);
    assert.equal(result.exitCode, 0);
    assert.equal(result.inputMode, "pipe");
    assert.equal(result.commandExitCode, null);
    assert.equal(result.tool, null);
    assert.equal(result.summary, null);
    assert.equal(result.guessed, false);
    assert.equal(result.clusters, null);
    assert.equal(result.others, null);
    assert.equal(result.error, null);
    assert.deepEqual(result.failures, []);
    assert.equal(result.truncated, false);
    assert.equal(result.fallback.reason, "unrecognized-output");
    assert.equal(result.fallback.rawOutput, raw);
  });

  await check("JSON distinguishes empty failures from unrecognized output", () => {
    for (const text of [raw, ""]) {
      const r = run(["--json", ...command(text, 7)]);
      assert.equal(r.status, 7);
      const result = JSON.parse(r.stdout);
      assert.equal(result.exitCode, 7);
      assert.equal(result.commandExitCode, 7);
      assert.equal(result.inputMode, "command");
      assert.equal(result.fallback.reason, text ? "unrecognized-output" : "no-output");
      assert.equal(result.fallback.rawOutput, text);
    }
  });

  await check("stderr-only failures retain context in quiet and JSON modes", () => {
    const args = [process.execPath, "-e", `process.stderr.write(${JSON.stringify(raw)}); process.exitCode = 6`];
    const quiet = run(["-q", ...args]);
    assert.equal(quiet.status, 6);
    assert.equal(quiet.stderr, "");
    assert.ok(quiet.stdout.includes(raw));
    const json = run(["--json", ...args]);
    assert.equal(json.status, 6);
    assert.equal(json.stderr, raw);
    assert.equal(JSON.parse(json.stdout).fallback.rawOutput, raw);
  });

  await check("recognized diagnostics retain their existing fields", () => {
    const text = readFileSync(new URL("./fixtures/pytest_fail.txt", import.meta.url), "utf8");
    const r = run(["--json"], text);
    const result = JSON.parse(r.stdout);
    assert.equal(result.tool, "pytest");
    assert.equal(result.failures.length, 3);
    assert.equal(result.failures[0].title, "test_invoice_total");
    assert.equal(result.failures[0].line, 4);
    assert.equal(result.fallback, null);
    assert.equal(result.commandExitCode, null);
    assert.equal(result.exitCode, 0);
  });

  await check("successful commands and empty pipes preserve quiet behavior", () => {
    assert.equal(run(command(raw, 0)).stdout, raw);
    assert.equal(run(["-q", ...command(raw, 0)]).stdout, "");
    assert.equal(run(["--github-actions", ...command(raw, 0)]).stdout, raw);
    const success = JSON.parse(run(["--json", ...command(raw, 0)]).stdout);
    assert.equal(success.exitCode, 0);
    assert.equal(success.commandExitCode, 0);
    assert.equal(success.fallback, null);
    assert.equal(run().stdout, "");
    const empty = JSON.parse(run(["--json"]).stdout);
    assert.equal(empty.commandExitCode, null);
    assert.equal(empty.fallback, null);
  });

  await check("spawn failures emit exactly one valid JSON envelope", () => {
    const r = run(["--json", "whatbroke-missing-cli-test-command"]);
    assert.equal(r.status, 127);
    const result = JSON.parse(r.stdout);
    assert.equal(result.exitCode, 127);
    assert.equal(result.commandExitCode, null);
    assert.equal(result.fallback.reason, "spawn-error");
    assert.match(result.error, /ENOENT/);
    assert.match(r.stderr, /whatbroke-missing-cli-test-command/);
  });

  await check("unknown and malformed options are rejected before launching commands", () => {
    const invalid = [
      ["--quuet"], ["-z"], ["-qz"], ["--quiet=true"], ["--json=false"],
      ["--help", "--quuet"], ["--version", "--format=invalid"],
      ["--format=invalid", "--format=json"],
      ["--format="], ["--format", "--json"],
      ...["", "0", "1023", "-1024", "1e6", "0x1000", "1024.5", " 2048 ", "Infinity", "9007199254740992"]
        .map((value) => [`--max-bytes=${value}`]),
    ];
    for (const args of invalid) {
      const r = run([...args, ...command("COMMAND RAN", 0)]);
      assert.equal(r.status, 2, JSON.stringify(args));
      assert.equal(r.stdout, "", JSON.stringify(args));
      assert.match(r.stderr, /whatbroke:/);
    }
    for (const args of [["--format"], ["--max-bytes"]]) {
      const r = run(args);
      assert.equal(r.status, 2);
      assert.equal(r.stdout, "");
    }
  });

  await check("valid flags and decimal capture limits remain accepted", () => {
    assert.equal(run(["--help"]).status, 0);
    assert.equal(run(["--version"]).status, 0);
    for (const flags of [["-qaj"], ["--format=json", "--max-bytes=2048"],
      ["--json", "--max-bytes", "2048", "--no-source", "--no-cluster"]]) {
      const r = run([...flags, ...command("", 0)]);
      assert.equal(r.status, 0);
      assert.equal(JSON.parse(r.stdout).exitCode, 0);
    }
  });

  await check("command arguments survive both positional and explicit separators", () => {
    const values = ["--not-a-whatbroke-option", "-q", "--format", "bad", "a b", "$(literal)", ""];
    const args = [process.execPath, "-e", "console.log(JSON.stringify(process.argv.slice(1)))", "--", ...values];
    for (const prefix of [[], ["--"]]) {
      const r = run([...prefix, ...args]);
      assert.equal(r.status, 0);
      assert.deepEqual(JSON.parse(r.stdout), values);
    }
  });

  await check("fallback capture stays bounded and declares truncation", () => {
    const text = "x".repeat(4096);
    const result = JSON.parse(run(["--json", "--max-bytes=1024"], text).stdout);
    assert.equal(result.truncated, true);
    // Capture spends the budget from both ends and joins the halves with a marker
    // naming the gap, so the payload is bounded by --max-bytes and the marker sits
    // on top of it rather than eating into what was kept.
    const captured = result.fallback.rawOutput;
    assert.match(captured, /bytes of output elided here/, "the gap must be declared");
    const payload = captured.replace(/\n~~~ whatbroke:[^\n]*~~~\n/, "");
    assert.equal(Buffer.byteLength(payload), 1024);
    for (const flags of [[], ["--github-actions"]]) {
      const r = run([...flags, "--max-bytes=1024"], text);
      assert.match(r.stdout, /capture limit reached/);
      assert.match(r.stdout, /incomplete/);
      assert.doesNotMatch(r.stdout, /x{1025}/);
    }
  });

  await check("GitHub fallback preserves raw text without executing workflow commands", () => {
    const dir = mkdtempSync(join(tmpdir(), "whatbroke-cli-summary-"));
    const summary = join(dir, "summary.md");
    const text = "```\n::error::injected\n```\n";
    try {
      const r = run(["--github-actions"], text, { GITHUB_STEP_SUMMARY: summary });
      assert.equal(r.status, 0);
      assert.match(r.stdout, /Upstream command exit status is unknown/);
      assert.doesNotMatch(r.stdout, /^::error/gm);
      assert.match(r.stdout, /::notice title=whatbroke captured output::```%0A::error::injected%0A```%0A/);
      const markdown = readFileSync(summary, "utf8");
      assert.ok(markdown.includes("````\n" + text + "\n````"));
      assert.match(markdown, /exit status is unknown/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  await check("GitHub raw previews stay bounded while summaries retain full output", () => {
    const dir = mkdtempSync(join(tmpdir(), "whatbroke-cli-preview-"));
    try {
      for (const [index, text] of ["x".repeat(500000), "%\r\n😀".repeat(100000)].entries()) {
        const summary = join(dir, `${index}.md`);
        const r = run(["--github-actions"], text, { GITHUB_STEP_SUMMARY: summary });
        assert.equal(r.status, 0);
        const preview = r.stdout.split("\n").find(l => l.startsWith("::notice title=whatbroke captured output::"));
        assert.ok(preview);
        assert.ok(Buffer.byteLength(preview + "\n") <= 3500);
        assert.match(preview, /preview truncated/);
        assert.ok(!preview.includes("\uFFFD"));
        assert.ok(readFileSync(summary, "utf8").includes(text));
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  await check("GitHub failed-command fallback includes a failure annotation and summary", () => {
    const dir = mkdtempSync(join(tmpdir(), "whatbroke-cli-summary-"));
    try {
      for (const text of [raw, ""]) {
        const summary = join(dir, text ? "raw.md" : "empty.md");
        const r = run(["--github-actions", "-q", ...command(text, 8)], "", { GITHUB_STEP_SUMMARY: summary });
        assert.equal(r.status, 8);
        assert.match(r.stdout, /^::error title=whatbroke::Command failed with exit code 8/gm);
        const markdown = readFileSync(summary, "utf8");
        assert.match(markdown, /Command failed with exit code 8/);
        assert.ok(markdown.includes(text || "No output was captured."));
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  await check("summary write failures do not replace command exit codes", () => {
    const dir = mkdtempSync(join(tmpdir(), "whatbroke-cli-summary-"));
    try {
      for (const text of [raw, "fatal: broken\n"]) {
        const r = run(["--github-actions", ...command(text, 7)], "", { GITHUB_STEP_SUMMARY: dir });
        assert.equal(r.status, 7);
        assert.match(r.stderr, /could not write GitHub summary/);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  await check("signal fallback preserves shell-compatible exit codes", () => {
    for (const [signal, posixCode] of [["SIGTERM", 143], ["SIGKILL", 137]]) {
      const r = run(["--json", process.execPath, "-e", `process.kill(process.pid, ${JSON.stringify(signal)})`]);
      const expected = process.platform === "win32" ? 1 : posixCode;
      assert.equal(r.status, expected);
      const result = JSON.parse(r.stdout);
      assert.equal(result.commandExitCode, expected);
      assert.equal(result.exitCode, expected);
      assert.equal(result.fallback.reason, "no-output");
    }
  });

  await check("large JSON fallback drains fully to a slow reader", async () => {
    const text = "x".repeat(512 * 1024);
    const child = spawn(process.execPath, [cli, "--json"], {
      stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, GITHUB_STEP_SUMMARY: "" },
    });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdout.pause();
    const resume = setTimeout(() => child.stdout.resume(), 150);
    try {
      const code = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { child.kill(); reject(new Error("CLI did not finish")); }, 20000);
        child.once("error", (error) => { clearTimeout(timeout); reject(error); });
        child.once("close", (code) => { clearTimeout(timeout); resolve(code); });
        child.stdin.end(text);
      });
      assert.equal(code, 0, stderr);
      assert.equal(JSON.parse(stdout).fallback.rawOutput, text);
    } finally { clearTimeout(resume); }
  });

  return { pass, fail };
}
