import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Keep CLI contract tests separate from parser fixtures and source-safety tests.
export async function runCliTests(cli = fileURLToPath(new URL("../bin/whyitbroke.js", import.meta.url))) {
  let pass = 0, fail = 0;
  const raw = "The operation did not complete.\nSee the attached report.\n";
  const run = (args = [], input = "", env = {}, cwd) => {
    const r = spawnSync(process.execPath, [cli, ...args], {
      input, encoding: "utf8", timeout: 20000, maxBuffer: 16 * 1024 * 1024, cwd,
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
    const r = run(["--json", "whyitbroke-missing-cli-test-command"]);
    assert.equal(r.status, 127);
    const result = JSON.parse(r.stdout);
    assert.equal(result.exitCode, 127);
    assert.equal(result.commandExitCode, null);
    assert.equal(result.fallback.reason, "spawn-error");
    // What the shell would have said, with the errno kept for a bug report. A command
    // that will not start is most often a typo, and "spawn x ENOENT" is node's wording
    // for it where every shell says "command not found".
    assert.equal(result.error, "whyitbroke-missing-cli-test-command: command not found (ENOENT)");
    assert.match(r.stderr, /whyitbroke-missing-cli-test-command/);
  });

  await check("a command that cannot be executed is reported, not thrown", () => {
    // Not every spawn failure arrives the same way. ENOENT is delivered as an "error"
    // event on the child; ENOEXEC - the kernel refusing to exec a file, which is what a
    // script with no shebang is - is raised by spawn() itself, before any handler can be
    // attached to a child that was never created. Both mean the command never started,
    // so both have to produce the same report rather than a node stack trace. pnpm ships
    // a placeholder binary with no shebang, so `whyitbroke -- pnpm test` reached this.
    //
    // A shebang is a POSIX idea: Windows decides how to run a file from its extension,
    // so there is no ENOEXEC to provoke there. The synchronous path this covers is still
    // exercised on every platform by the empty-name case below.
    if (process.platform === "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "whyitbroke-noexec-"));
    const script = join(dir, "no-shebang-cli-test");
    writeFileSync(script, "echo hello\n", { mode: 0o755 });
    try {
      const r = run(["--json", script]);
      // What happens next is node's choice, not this tool's: posix_spawn reports
      // ENOEXEC, while execvp retries the file under /bin/sh and runs it. Both are
      // legitimate and both ship in supported node versions, so the assertion is the
      // part that is whyitbroke's to keep - it never throws, and stdout is always one
      // valid report.
      assert.doesNotMatch(r.stderr, /internal\/child_process/, "the failure escaped as a stack trace");
      const result = JSON.parse(r.stdout);
      if (result.fallback?.reason !== "spawn-error") return;   // node ran it under sh
      assert.equal(r.status, 127);
      assert.equal(result.exitCode, 127);
      assert.equal(result.commandExitCode, null);
      // Not the errno's name: node calls this one ENOEXEC on some versions and
      // "Unknown system error -8" on others, which is the same number unmapped. What is
      // asserted is what belongs to whyitbroke - that the report says which command
      // could not start, whatever node called the reason. On the versions that DO name
      // it, node leaves the file out of the message, so this is not free either way.
      assert.match(result.error, /no-shebang-cli-test/);
      assert.match(r.stderr, /no-shebang-cli-test/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  await check("an empty command name is a spawn failure, not a crash", () => {
    // `whyitbroke -- $CMD` in a script where CMD is unset. node rejects the empty name
    // from spawn() itself, the same synchronous path as ENOEXEC, and the report it used
    // to produce was a stack trace and an exit code that belonged to whyitbroke.
    const r = run(["--json", ""]);
    assert.equal(r.status, 127);
    const result = JSON.parse(r.stdout);
    assert.equal(result.exitCode, 127);
    assert.equal(result.commandExitCode, null);
    assert.equal(result.fallback.reason, "spawn-error");
    // node's own wording here is "The argument 'file' cannot be empty. Received ''",
    // which is about its API rather than about the run.
    assert.equal(result.error, "no command given");
    assert.doesNotMatch(r.stderr, /internal\/child_process|node:child_process/);
  });

  await check("a saved log mistaken for a command is told how to be read", () => {
    // `whyitbroke build.log` is the first thing someone with a log already on disk tries.
    // The working directory is not on $PATH, so it misses with ENOENT and the answer the
    // tool gave was about $PATH - while the file it could have distilled sat right there.
    const dir = mkdtempSync(join(tmpdir(), "whyitbroke-savedlog-"));
    const log = "src/app.py:3: error: boom\n";
    writeFileSync(join(dir, "build.log"), log);
    writeFileSync(join(dir, "runme.sh"), "echo hello\n", { mode: 0o755 });
    try {
      const r = run(["--json", "build.log"], "", {}, dir);
      assert.equal(r.status, 127);
      assert.match(r.stderr, /build\.log is a file, not a command/);
      // The suggestion has to be a command that works, not a gesture at one.
      const suggested = /to distil it: whyitbroke < (.+)\n/.exec(r.stderr);
      assert.ok(suggested, `no suggestion in stderr: ${r.stderr}`);
      assert.equal(suggested[1], "build.log");
      const piped = run(["--json"], log, {}, dir);
      assert.equal(JSON.parse(piped.stdout).failures.length, 1);
      // Advice belongs on stderr: --json stdout stays one machine-readable report, and
      // never the hint.
      //
      // What the error *says* is not asserted here, because it is not this tool's to
      // decide: a name that is not on $PATH is ENOENT, Windows runs a file by its
      // extension and calls one it cannot run EFTYPE on node 22 and 24 - and UNKNOWN on
      // 18 and 20, the same Win32 error left untranslated. The plain wording is pinned
      // by the missing-command test above, where every platform agrees on ENOENT. What
      // is whyitbroke's here is that the report names the file that would not start,
      // whatever the platform called the reason. This is the same split the ENOEXEC
      // test makes, for the same reason.
      const result = JSON.parse(r.stdout);
      assert.match(result.error, /build\.log/);
      assert.doesNotMatch(r.stdout, /to distil it/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  await check("only a file that cannot be run is offered as a log", () => {
    // Guards on the suggestion above. A script whose shebang is missing, a directory, a
    // name that is nothing at all, and a real command line with arguments must not be
    // told to pipe themselves in - `< file` would drop the arguments, and the other
    // three are not logs. Windows has no execute bit, so runnability is the extension
    // there; a .sh is not runnable on Windows and is correctly offered as a log.
    const dir = mkdtempSync(join(tmpdir(), "whyitbroke-notalog-"));
    writeFileSync(join(dir, "build.log"), "boom\n");
    writeFileSync(join(dir, "runme.sh"), "echo hello\n", { mode: 0o755 });
    mkdirSync(join(dir, "adir"));
    // A directory usually carries its execute bit, which would mask a missing isFile()
    // check. One without it is the case that tells the two apart.
    mkdirSync(join(dir, "unsearchable"), { mode: 0o644 });
    try {
      const cases = [["adir"], ["unsearchable"], ["missing.log"], ["build.log", "--all"]];
      if (process.platform !== "win32") cases.push(["runme.sh"]);
      for (const args of cases) {
        const r = run(args, "", {}, dir);
        assert.doesNotMatch(r.stderr, /to distil it/, `offered ${args.join(" ")} as a log`);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  await check("a reader that stops reading ends the run quietly", async () => {
    // `whyitbroke npm test | head` - the reader has the lines it wanted and closes the
    // pipe. node ignores SIGPIPE and raises EPIPE on the stream instead, and the
    // unhandled 'error' event was a node stack trace from the tool that exists to keep
    // those off the screen.
    //
    // Handling the error alone is not enough, and the crash was hiding the worse half:
    // relay pauses the child when the destination is full and waits for a drain, and a
    // destination nobody is reading never drains. The child blocks on its next write and
    // the run never ends.
    const child = spawn(process.execPath, [cli, "--", process.execPath, "-e",
      "for (let i = 1; i <= 200000; i++) console.log(`a.py:${i}: error: thing ${i}`); process.exitCode = 3"],
      { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" } });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdout.once("data", () => child.stdout.destroy());
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("the run did not end after the reader went away"));
      }, 30000);
      child.once("close", (c) => { clearTimeout(timer); resolve(c); });
      child.once("error", (e) => { clearTimeout(timer); reject(e); });
    });
    assert.doesNotMatch(stderr, /EPIPE|Unhandled .error.|internal\/stream|node:internal/,
      `a write error reached the terminal: ${stderr}`);
    // The command's exit code is whyitbroke's promise to a Makefile. Who was reading its
    // output is not the command's business and must not change what it reports.
    assert.equal(code, 3, "the wrapped command's exit code survives the reader going away");
  });

  await check("a closed pipe on a piped log is quiet too", async () => {
    // The other half of the same fault, and the half relay cannot cover: `cat build.log |
    // whyitbroke | head` never wraps a command, so nothing attaches a listener to stdout
    // and the report write raises EPIPE on its own. The log has to be big enough that
    // the report does not fit in the pipe buffer, or the write lands before the reader
    // has gone and there is nothing to survive.
    const log = Array.from({ length: 4000 },
      (_, i) => `a${i}.py:${i + 1}: error: thing ${i} is wrong and this message is not short`).join("\n") + "\n";
    const child = spawn(process.execPath, [cli, "--json", "-a"],
      { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" } });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdout.once("data", () => child.stdout.destroy());
    child.stdin.end(log);
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("the run did not end after the reader went away"));
      }, 30000);
      child.once("close", (c) => { clearTimeout(timer); resolve(c); });
      child.once("error", (e) => { clearTimeout(timer); reject(e); });
    });
    assert.doesNotMatch(stderr, /EPIPE|Unhandled .error.|internal\/stream|node:internal/,
      `a write error reached the terminal: ${stderr}`);
    assert.equal(code, 0, "piped input still exits 0, as the README says it does");
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
      assert.match(r.stderr, /whyitbroke:/);
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
    const values = ["--not-a-whyitbroke-option", "-q", "--format", "bad", "a b", "$(literal)", ""];
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
    const payload = captured.replace(/\n~~~ whyitbroke:[^\n]*~~~\n/, "");
    assert.equal(Buffer.byteLength(payload), 1024);
    for (const flags of [[], ["--github-actions"]]) {
      const r = run([...flags, "--max-bytes=1024"], text);
      assert.match(r.stdout, /capture limit reached/);
      assert.match(r.stdout, /incomplete/);
      assert.doesNotMatch(r.stdout, /x{1025}/);
    }
  });

  await check("GitHub fallback preserves raw text without executing workflow commands", () => {
    const dir = mkdtempSync(join(tmpdir(), "whyitbroke-cli-summary-"));
    const summary = join(dir, "summary.md");
    // A payload with nothing that looks like a diagnostic, so this really does reach
    // the fallback path - which is the path being tested. `::error::` is covered by the
    // parsed path below, now that a line saying "error:" is recognised.
    const text = "```\n::set-output name=a::b\n```\n";
    try {
      const r = run(["--github-actions"], text, { GITHUB_STEP_SUMMARY: summary });
      assert.equal(r.status, 0);
      assert.match(r.stdout, /Upstream command exit status is unknown/);
      assert.doesNotMatch(r.stdout, /^::error/gm);
      assert.match(r.stdout, /::notice title=whyitbroke captured output::```%0A::set-output name=a::b%0A```%0A/);
      const markdown = readFileSync(summary, "utf8");
      assert.ok(markdown.includes("````\n" + text + "\n````"));
      assert.match(markdown, /exit status is unknown/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  await check("a workflow command inside a parsed log cannot become a real one", () => {
    // The fallback path escapes raw text. The parsed path does not go through that, so
    // a log whose diagnostic lines contain workflow commands has to be checked too.
    const text = 'error: x\n::error file=evil.js,line=1::pwned\n::notice::also-pwned\n';
    const r = run(["--github-actions"], text, { GITHUB_STEP_SUMMARY: "" });
    const commands = (r.stdout.match(/^::\w+/gm) ?? []);
    assert.equal(commands.length, 1, `emitted ${commands.length} workflow commands: ${r.stdout}`);
    assert.doesNotMatch(r.stdout, /file=evil\.js/, "an injected annotation became a real one");
    assert.doesNotMatch(r.stdout, /also-pwned/);
  });

  await check("GitHub raw previews stay bounded while summaries retain full output", () => {
    const dir = mkdtempSync(join(tmpdir(), "whyitbroke-cli-preview-"));
    try {
      for (const [index, text] of ["x".repeat(500000), "%\r\n😀".repeat(100000)].entries()) {
        const summary = join(dir, `${index}.md`);
        const r = run(["--github-actions"], text, { GITHUB_STEP_SUMMARY: summary });
        assert.equal(r.status, 0);
        const preview = r.stdout.split("\n").find(l => l.startsWith("::notice title=whyitbroke captured output::"));
        assert.ok(preview);
        assert.ok(Buffer.byteLength(preview + "\n") <= 3500);
        assert.match(preview, /preview truncated/);
        assert.ok(!preview.includes("\uFFFD"));
        assert.ok(readFileSync(summary, "utf8").includes(text));
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  await check("GitHub failed-command fallback includes a failure annotation and summary", () => {
    const dir = mkdtempSync(join(tmpdir(), "whyitbroke-cli-summary-"));
    try {
      for (const text of [raw, ""]) {
        const summary = join(dir, text ? "raw.md" : "empty.md");
        const r = run(["--github-actions", "-q", ...command(text, 8)], "", { GITHUB_STEP_SUMMARY: summary });
        assert.equal(r.status, 8);
        assert.match(r.stdout, /^::error title=whyitbroke::Command failed with exit code 8/gm);
        const markdown = readFileSync(summary, "utf8");
        assert.match(markdown, /Command failed with exit code 8/);
        assert.ok(markdown.includes(text || "No output was captured."));
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  await check("summary write failures do not replace command exit codes", () => {
    const dir = mkdtempSync(join(tmpdir(), "whyitbroke-cli-summary-"));
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
