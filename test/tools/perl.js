// Perl: perl and its TAP.
//
// Each case is a real capture in test/fixtures/, read the way whatbroke reads it; each
// format group is one run captured in several formats, which have to agree. The checks
// below them are about how this family's tools print what they print.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { analyse } from "../../src/index.js";
import { agreeAcrossFormats, cli, fx, here, runCases } from "./harness.js";

const CASES = [
  // Captured on the system perl, 5.34. Perl puts the location at the end of the message,
  // in prose, so nothing recognised it and a failing perl script produced no diagnosis.
  { file: "perl_die_fail.txt", tool: "perl", n: 1, check: (r) => {
      assert.equal(r.failures[0].file, "p_die.pl");
      assert.equal(r.failures[0].line, 2);
      assert.equal(r.failures[0].message, "no price for item");
      assert.equal(r.summary, undefined, "a summary that repeats the only failure says it twice");
    } },
  { file: "perl_syn_fail.txt", tool: "perl", n: 1, check: (r) => {
      // "near \"= ;\"" is what the parser choked on - the useful half of a syntax error.
      assert.match(r.failures[0].message, /^syntax error \(near "= ;"\)$/);
      // "Execution of ... aborted due to compilation errors." restates it and is dropped
      assert.equal(r.failures.length, 1);
    } },
  { file: "perl_inc_fail.txt", tool: "perl", n: 1, check: (r) => {
      // The module search path is longer than the diagnosis and never varies.
      assert.doesNotMatch(r.failures[0].message, /@INC contains/);
      assert.match(r.failures[0].message, /Can't locate NoSuch\/Module\/Xyz\.pm/);
      assert.match(r.failures[0].message, /you may need to install the NoSuch::Module::Xyz module/);
      assert.equal(r.failures[0].line, 2, "BEGIN failed--compilation aborted is not a second failure");
    } },
  { file: "perl_undef_fail.txt", tool: "perl", n: 1, check: (r) => {
      assert.match(r.failures[0].message, /^Can't call method "render" on an undefined value$/);
    } },
  { file: "perl_warn_fail.txt", tool: "perl", n: 1, check: (r) => {
      // Perl marks nothing: a warning and a fatal die are written in exactly the same
      // shape. The only thing separating them is what the message says, so the warning
      // is matched by phrase - and the die, which is the failure, is what gets reported.
      assert.equal(r.failures[0].line, 7);
      assert.equal(r.failures[0].message, "cannot reach the billing service");
      assert.equal(r.summary, "1 error, 1 warning");
      assert.doesNotMatch(JSON.stringify(r.failures), /uninitialized/, "a warning was reported as a failure");
    } },
  // One real Test::More suite, recorded twice: run directly, and under `prove -v`.
  { file: "perl_tap_fail.txt", tool: "tap", n: 2, check: (r) => {
      assert.equal(r.summary, "2 failed, 1 passed", "the plan says how many ran");
      assert.deepEqual(r.failures.map((f) => f.title), ["invoice total", "code matches"]);
      assert.equal(r.failures[0].file, "shop.t");
      assert.equal(r.failures[0].line, 5);
      assert.equal(r.failures[0].message, "expected '1050', got '1049'");
      assert.doesNotMatch(JSON.stringify(r.failures), /Failed test|^"#"$/m);
    } },
  { file: "perl_prove_fail.txt", tool: "tap", n: 2, check: (r) => {
      // prove prints the diagnostics BEFORE the stream, so nothing sits under the
      // result line. Test::More names the test it is describing, and that name is the
      // same string the `not ok` line carries - so the two are matched on it.
      assert.deepEqual(r.failures.map((f) => f.line), [5, 7]);
      assert.equal(r.failures[0].message, "expected '1050', got '1049'");
      // "Dubious, test returned 2" follows the stream and belongs to no test.
      assert.doesNotMatch(JSON.stringify(r.failures), /Dubious|subtests/);
    } },
];

let pass = 0, fail = 0;
for (const result of [runCases(CASES)]) {
  pass += result.pass;
  fail += result.fail;
}


// A reporter is a presentation, not a different failure.
try {
  const raw = analyse(fx("perl_tap_fail.txt"));
  const prove = analyse(fx("perl_prove_fail.txt"));
  const facts = (r) => r.failures.map((f) => [f.file, f.line, f.title, f.message]);
  assert.deepEqual(facts(prove), facts(raw), "prove -v and raw TAP disagree about one suite");
  console.log("  ok   prove -v and raw TAP say the same thing");
  pass++;
} catch (e) { console.log(`  FAIL prove -v vs raw TAP\n       ${e.message}`); fail++; }

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
