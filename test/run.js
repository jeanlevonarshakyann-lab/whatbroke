import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { analyse } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n) => readFileSync(join(here, "fixtures", n), "utf8");
const cli = join(here, "..", "bin", "whatbroke.js");

const CASES = [
  { file: "pytest_fail.txt", tool: "pytest", n: 3, check: (r) => {
      assert.match(r.summary, /3 failed, 2 passed/);
      const f = r.failures[0];
      assert.equal(f.title, "test_invoice_total");
      assert.equal(f.line, 4);
      assert.match(f.file, /test_shop\.py$/);
      assert.match(f.message, /assert 1049 == 1050/);
      assert.equal(r.failures[1].message, "KeyError: 'exp'");
      assert.equal(r.failures[2].title, "test_param[2]");
    } },
  { file: "py_unittest.txt", tool: "unittest", n: 2, check: (r) => {
      assert.match(r.summary, /Ran 3 tests/);
      assert.ok(r.failures.some((f) => /1049 != 1050/.test(f.message)));
      assert.ok(r.failures.every((f) => f.line > 0));
    } },
  { file: "py_traceback.txt", tool: "python", n: 1, check: (r) => {
      const f = r.failures[0];
      assert.equal(f.message, "KeyError: 'taxrate'");
      assert.equal(f.line, 6);          // deepest USER frame, not the entrypoint
      assert.equal(f.title, "main");
    } },
  { file: "node_stack.txt", tool: "node", n: 1, check: (r) => {
      const f = r.failures[0];
      assert.equal(f.title, "TypeError");
      assert.match(f.message, /Cannot read properties of null/);
      assert.equal(f.line, 1);
      assert.ok(f.hiddenFrames >= 5, "node internals should be hidden");
      assert.ok(f.trace.every((t) => !/node:internal/.test(t)));
    } },
  { file: "tsc_plain.txt", tool: "tsc", n: 3, check: (r) => {
      assert.equal(r.failures[0].title, "TS2551");
      assert.equal(r.failures[0].line, 2);
      assert.equal(r.failures[0].col, 52);
      assert.match(r.summary, /3 errors in 1 file/);
    } },
  { file: "node_eval.txt", tool: "node", n: 1, check: (r) => {
      const f = r.failures[0];
      assert.equal(f.title, "TypeError");
      assert.equal(f.file, "[eval]");
      assert.equal(f.stmt, "null.x");
      // node's own eval wrapper must never be shown as user code
      assert.ok(!f.trace.some((t) => /\[eval\]-wrapper|node:internal/.test(t)),
        `wrapper frame leaked: ${JSON.stringify(f.trace)}`);
      assert.equal(f.hiddenFrames, 7);
    } },
  { file: "vitest_fail.txt", tool: "vitest", n: 3, check: (r) => {
      assert.match(r.summary, /3 failed \| 1 passed/);
      const f = r.failures[0];
      assert.equal(f.title, "invoice total");
      assert.equal(f.line, 3);
      assert.equal(f.col, 62);
      assert.match(f.message, /expected 1049 to be 1050/);
      assert.match(f.message, /1050/);          // keeps the expected/received diff
      assert.equal(r.failures[2].title, "throws");
      assert.match(r.failures[2].message, /TypeError/);
    } },
  { file: "eslint_fail.txt", tool: "eslint", n: 3, check: (r) => {
      // warnings are not errors: 4 problems reported, 3 shown
      assert.match(r.summary, /1 warning hidden/);
      assert.equal(r.failures[0].title, "no-unused-vars");
      assert.equal(r.failures[0].line, 1);
      assert.equal(r.failures[0].col, 7);
      assert.ok(r.failures.every((f) => /messy\.js$/.test(f.file)), "file must attach to each problem");
      assert.equal(r.failures[2].title, "no-undef");
    } },
  { file: "jest_fail.txt", tool: "jest", n: 2, check: (r) => {
      assert.match(r.summary, /2 failed, 1 passed/);
      const f = r.failures[0];
      assert.equal(f.title, "invoice total");
      assert.equal(f.file, "sum.test.js");
      assert.equal(f.line, 2);
      assert.match(f.message, /toBe\(expected\)/);
      assert.match(f.message, /Expected: 1050/);
      assert.match(f.message, /Received: 1049/);
      assert.equal(r.failures[1].title, "expired token");
    } },
  { file: "gotest_fail.txt", tool: "go test", n: 3, check: (r) => {
      assert.match(r.summary, /3 tests failed/);
      assert.equal(r.failures[0].title, "TestInvoiceTotal");
      assert.equal(r.failures[0].line, 8);
      assert.match(r.failures[0].message, /Total\(\) = 1049, want 1050/);
      const panic = r.failures[2];
      assert.equal(panic.title, "TestPanics");
      assert.match(panic.message, /panic: assignment to entry in nil map/);
      // must resolve past Go's runtime/testing frames to the user's line
      assert.equal(panic.line, 27);
      assert.match(panic.file, /shop_test\.go$/);
    } },
  { file: "gobuild_fail.txt", tool: "go build", n: 3, check: (r) => {
      assert.match(r.summary, /3 compile errors/);
      assert.equal(r.failures[0].file, "broken.go");   // leading "./" stripped
      assert.equal(r.failures[0].line, 4);
      assert.equal(r.failures[0].col, 17);
      assert.match(r.failures[1].message, /undefined: undefinedCall/);
    } },
  { file: "cargotest_fail.txt", tool: "cargo test", n: 2, check: (r) => {
      assert.equal(r.summary, "1 passed; 2 failed");   // zero-count noise dropped
      const f = r.failures.find((x) => x.title === "tests::invoice_total");
      assert.ok(f, "invoice_total not found");
      assert.equal(f.file, "src/lib.rs");
      assert.equal(f.line, 11);
      assert.match(f.message, /assertion `left == right` failed/);
      assert.match(f.message, /left: 1049/);
      assert.ok(!/RUST_BACKTRACE/.test(f.message), "backtrace note should be dropped");
    } },
  { file: "cargobuild_fail.txt", tool: "cargo", n: 3, check: (r) => {
      assert.equal(r.failures[0].title, "E0308");
      assert.equal(r.failures[0].file, "src/lib.rs");
      assert.equal(r.failures[0].line, 2);
      assert.match(r.failures[0].message, /expected `String`, found integer/);
      // E0277 prints 25 lines of trait impls from rustlib; none may leak through
      const e0277 = r.failures[1];
      assert.equal(e0277.title, "E0277");
      assert.equal(e0277.line, 3);
      assert.ok(!/rustlib|internal_macros/.test(e0277.message), "rustlib noise leaked");
      assert.ok(r.failures.every((f) => !/could not compile/.test(f.message)),
        "the error tally must not be counted as an error");
    } },
  { file: "gosub_fail.txt", tool: "go test", n: 2, check: (r) => {
      // the parent "--- FAIL: TestTable" is a container, not a third failure
      assert.equal(r.summary, "2 tests failed");
      assert.equal(r.failures[0].title, "TestTable/one");
      assert.equal(r.failures[0].file, "sub_test.go");
      assert.equal(r.failures[0].line, 18);
      assert.match(r.failures[0].message, /Total\(\[5\]\) = 5, want 6/);
      assert.equal(r.failures[1].title, "TestTable/many");
      assert.ok(!r.failures.some((f) => f.title === "TestTable"), "parent must not be reported");
    } },
  { file: "ruff_fail.txt", tool: "ruff", n: 4, check: (r) => {
      assert.equal(r.summary, "4 errors");
      assert.equal(r.failures[0].title, "F401");
      assert.equal(r.failures[0].file, "messy.py");
      assert.equal(r.failures[0].line, 1);
      assert.equal(r.failures[0].col, 8);
      assert.match(r.failures[0].message, /`os` imported but unused/);
      assert.match(r.failures[0].message, /Remove unused import/);  // keeps ruff's fix hint
      assert.equal(r.failures[3].title, "E711");
      // ruff and cargo share the " --> file:line:col" shape; they must not cross-detect
      const cargo = analyse(fx("cargobuild_fail.txt"));
      assert.equal(cargo.tool, "cargo", "cargo output must not be claimed by ruff");
    } },
  { file: "mypy_fail.txt", tool: "mypy", n: 2, check: (r) => {
      assert.equal(r.summary, "2 errors in 1 files — 1 warning hidden");
      assert.equal(r.failures[0].title, "assignment");
      assert.equal(r.failures[0].file, "shop.py");
      assert.equal(r.failures[0].line, 4);
      assert.match(r.failures[1].message, /Argument 1/);
      assert.ok(!r.failures.some((f) => /Revealed type/.test(f.message)), "notes should not be failures");
    } },
  { file: "clang_fail.txt", tool: "clang", n: 1, check: (r) => {
      assert.equal(r.summary, "1 error — 1 warning hidden");
      assert.equal(r.failures[0].title, "error");
      assert.equal(r.failures[0].file, "main.cpp");
      assert.equal(r.failures[0].line, 7);
      assert.equal(r.failures[0].col, 12);
      assert.match(r.failures[0].message, /undeclared identifier/);
    } },
  { file: "rspec_fail.txt", tool: "rspec", n: 2, check: (r) => {
      assert.equal(r.summary, "2 examples, 2 failures");
      assert.equal(r.failures[0].title, "Invoice total calculates tax correctly");
      assert.equal(r.failures[0].file, "./spec/invoice_spec.rb");
      assert.equal(r.failures[0].line, 12);
      assert.match(r.failures[0].message, /expected: 1050/);
      assert.equal(r.failures[1].line, 27);
    } },
  { file: "maven_fail.txt", tool: "maven", n: 2, check: (r) => {
      assert.equal(r.summary, "build failed");
      assert.equal(r.failures[0].file, "/workspace/src/main/java/com/acme/Invoice.java");
      assert.equal(r.failures[0].line, 18);
      assert.equal(r.failures[0].col, 21);
      assert.match(r.failures[0].message, /incompatible types/);
    } },
  { file: "gradle_fail.txt", tool: "gradle", n: 2, check: (r) => {
      assert.equal(r.summary, "build failed");
      assert.equal(r.failures[0].file, "/workspace/src/main/kotlin/com/acme/Invoice.kt");
      assert.equal(r.failures[0].line, 14);
      assert.equal(r.failures[0].col, 17);
      assert.match(r.failures[1].message, /Unresolved reference/);
    } },
  { file: "gradle_java_fail.txt", tool: "gradle", n: 2, check: (r) => {
      assert.equal(r.summary, "build failed");
      assert.equal(r.failures[0].file, "/workspace/src/main/java/com/acme/Invoice.java");
      assert.equal(r.failures[0].line, 18);
      assert.equal(r.failures[0].col, undefined);
      assert.match(r.failures[1].message, /cannot find symbol/);
    } },
  { file: "dotnet_fail.txt", tool: "dotnet", n: 2, check: (r) => {
      assert.equal(r.summary, "2 errors — 1 warning hidden");
      assert.equal(r.failures[0].title, "CS0029");
      assert.equal(r.failures[0].file, "/workspace/src/Invoice.cs");
      assert.equal(r.failures[0].line, 18);
      assert.equal(r.failures[0].col, 21);
      assert.ok(r.failures.every((f) => !/\.csproj/.test(f.message)), "project metadata must not leak");
      assert.match(r.failures[1].message, /does not exist/);
    } },
  { file: "phpunit_fail.txt", tool: "phpunit", n: 2, check: (r) => {
      assert.equal(r.summary, "2 failures");
      assert.equal(r.failures[0].title, "Tests\\InvoiceTest::testTotal");
      assert.equal(r.failures[0].file, "/workspace/tests/InvoiceTest.php");
      assert.equal(r.failures[0].line, 17);
      assert.match(r.failures[1].message, /true is false/);
      assert.ok(r.failures.every((f) => !/Tests:/.test(f.message)), "summary must not be swallowed");
    } },
];

let pass = 0, fail = 0;
for (const c of CASES) {
  try {
    const r = analyse(fx(c.file));
    assert.ok(r, `${c.file}: nothing extracted`);
    assert.equal(r.tool, c.tool, `${c.file}: wrong tool`);
    assert.equal(r.failures.length, c.n, `${c.file}: expected ${c.n} failures, got ${r.failures.length}`);
    c.check(r);
    console.log(`  ok   ${c.file}  (${r.tool}, ${r.failures.length} failures)`);
    pass++;
  } catch (e) {
    console.log(`  FAIL ${c.file}\n       ${e.message}`);
    fail++;
  }
}

// crafted output must not be able to make us read files outside the working dir
try {
  const { render, setColor } = await import("../src/render.js");
  const { resetSnippetCache } = await import("../src/snippet.js");
  const { writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  setColor(false);
  const outside = join(tmpdir(), "whatbroke-must-not-read.txt");
  writeFileSync(outside, "TOP SECRET CONTENTS\n");
  resetSnippetCache();
  const out = render({ tool: "tsc", failures: [{ file: outside, line: 1, title: "TS1", message: "x" }] }, {});
  assert.ok(!/TOP SECRET/.test(out), "read a file outside the working directory");
  console.log("  ok   refuses to read source outside the working directory");
  pass++;
} catch (e) { console.log(`  FAIL path confinement\n       ${e.message}`); fail++; }

// context width adapts to how much the message explains, and never crosses a blank line
try {
  const { render, setColor } = await import("../src/render.js");
  const { resetSnippetCache } = await import("../src/snippet.js");
  const { writeFileSync, mkdtempSync, rmSync } = await import("node:fs");
  setColor(false);
  const dir = mkdtempSync(join(process.cwd(), ".tmp-ctx-"));
  const file = join(dir, "t.py");
  writeFileSync(file,
    "def setup():\n    a = 1\n    b = 2\n    return a\n\n\ndef other():\n    pass\n");

  resetSnippetCache();
  const bare = render({ tool: "t", failures: [
    { file, line: 4, title: "x", message: "KeyError: 'exp'" }] }, {});
  assert.match(bare, /def setup/, "a bare message should reach back for context");
  assert.ok(!/def other/.test(bare), "context must not spill into the next block");

  resetSnippetCache();
  const wordy = render({ tool: "t", failures: [
    { file, line: 4, title: "x",
      message: "Argument 1 to \"total\" has incompatible type \"str\"; expected \"list[int]\"" }] }, {});
  const count = (t) => (t.match(/^\s+\d+ \u2502/gm) || []).length;   // numbered source lines
  assert.ok(count(wordy) < count(bare),
    `a self-explanatory message should show less code (${count(wordy)} vs ${count(bare)})`);

  rmSync(dir, { recursive: true, force: true });
  console.log("  ok   context width adapts and stops at block boundaries");
  pass++;
} catch (e) { console.log(`  FAIL adaptive context\n       ${e.message}`); fail++; }

// CRLF input must parse identically to LF - Windows, and logs pasted from Windows CI
try {
  for (const name of ["pytest_fail.txt", "gotest_fail.txt", "cargobuild_fail.txt", "node_stack.txt"]) {
    const lf = analyse(fx(name));
    const crlf = analyse(fx(name).replace(/\n/g, "\r\n"));
    assert.ok(crlf, `${name}: nothing extracted from CRLF input`);
    assert.equal(crlf.tool, lf.tool, `${name}: CRLF changed the detected tool`);
    assert.equal(crlf.failures.length, lf.failures.length, `${name}: CRLF changed the failure count`);
    assert.deepEqual(crlf.failures.map((f) => f.line), lf.failures.map((f) => f.line),
      `${name}: CRLF changed the line numbers`);
    assert.ok(!JSON.stringify(crlf).includes("\\r"), `${name}: a carriage return survived into the output`);
  }
  console.log("  ok   CRLF input parses identically to LF");
  pass++;
} catch (e) { console.log(`  FAIL CRLF input\n       ${e.message}`); fail++; }

// source that changed since the run must not be shown as if it were current
try {
  const { render, setColor } = await import("../src/render.js");
  const { resetSnippetCache } = await import("../src/snippet.js");
  const { writeFileSync, mkdtempSync, rmSync } = await import("node:fs");
  setColor(false);
  // must live under cwd: source reads outside it are refused by design
  const dir = mkdtempSync(join(process.cwd(), ".tmp-test-"));
  const file = join(dir, "a.rs");

  writeFileSync(file, "let s: String = 42;\n");
  const result = { tool: "cargo", failures: [{ file, line: 1, title: "E0308",
    message: "mismatched types", stmt: "let s: String = 42;" }] };
  const fresh = render(result, {});
  assert.match(fresh, /1 . let s: String = 42;/, "matching file should show the snippet");
  assert.ok(!/has changed/.test(fresh), "matching file must not warn");

  writeFileSync(file, "something else entirely\n");
  resetSnippetCache();
  const drifted = render(result, {});
  assert.match(drifted, /has changed since this ran/, "changed file must warn");
  assert.ok(!/something else entirely/.test(drifted), "must not print the new file's contents");
  assert.equal((drifted.match(/let s: String = 42;/g) || []).length, 1, "line printed exactly once");
  rmSync(dir, { recursive: true, force: true });
  console.log("  ok   stale source is detected, not shown");
  pass++;
} catch (e) { console.log(`  FAIL stale source\n       ${e.message}`); fail++; }

// a clean run must not be mistaken for a failure
const CLEAN = "============ test session starts ============\ncollected 2 items\n\ntest_a.py ..    [100%]\n\n============ 2 passed in 0.01s ============\n";
try {
  const r = analyse(CLEAN);
  assert.ok(!r || r.failures.length === 0, "clean pytest run must yield no failures");
  console.log("  ok   clean run yields nothing");
  pass++;
} catch (e) { console.log(`  FAIL clean run\n       ${e.message}`); fail++; }

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
  const duplicate = "fatal: broken\nfatal: broken\n";
  const { analyse } = await import("../src/index.js");
  const r = analyse(duplicate);
  assert.equal(r.failures.length, 1);
  assert.equal(r.guessed, true);
  console.log("  ok   duplicate diagnostics are collapsed");
  pass++;
} catch (e) { console.log(`  FAIL duplicate diagnostics\n       ${e.message}`); fail++; }

try {
  const r = spawnSync(process.execPath, [cli, "--no-source", "node", "-e",
    "null.x"], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /Cannot read properties of null/);
  assert.match(r.stdout, /\[eval\]:1/);
  assert.ok(!/│ null\.x/.test(r.stdout), "source context must be disabled");
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
  const { analyse } = await import("../src/index.js");
  const malformed = [
    "", "\0\0", "\u001b[31m", "error:", "Found NaN errors", "file:not-a-line",
    "1) incomplete", "e: :::: ", "[ERROR] [1,2]", "!!!".repeat(1000),
  ];
  for (const input of malformed) assert.doesNotThrow(() => analyse(input));
  console.log("  ok   malformed and hostile logs never throw");
  pass++;
} catch (e) { console.log(`  FAIL malformed logs\n       ${e.message}`); fail++; }

try {
  const r = spawnSync(process.execPath, [cli, "--version"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+$/);
  console.log("  ok   version flag reports the package version");
  pass++;
} catch (e) { console.log(`  FAIL version flag\n       ${e.message}`); fail++; }

// every fixture must be covered
const files = readdirSync(join(here, "fixtures"));
const uncovered = files.filter((f) => !CASES.some((c) => c.file === f));
if (uncovered.length) console.log(`  note: uncovered fixtures: ${uncovered.join(", ")}`);

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
