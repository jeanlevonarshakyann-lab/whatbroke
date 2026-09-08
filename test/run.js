import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import { analyse } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n) => readFileSync(join(here, "fixtures", n), "utf8");

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

// source that changed since the run must not be shown as if it were current
try {
  const { render, setColor } = await import("../src/render.js");
  const { resetSnippetCache } = await import("../src/snippet.js");
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  setColor(false);
  const dir = mkdtempSync(join(tmpdir(), "whatbroke-"));
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

// every fixture must be covered
const files = readdirSync(join(here, "fixtures"));
const uncovered = files.filter((f) => !CASES.some((c) => c.file === f));
if (uncovered.length) console.log(`  note: uncovered fixtures: ${uncovered.join(", ")}`);

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
