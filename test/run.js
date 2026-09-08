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
