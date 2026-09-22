// Perl: perl and its TAP.
//
// Each case is a real capture in test/fixtures/, read the way whyitbroke reads it; each
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
  // The same suite a third time, under plain `prove` - which is how it is nearly always
  // run. prove consumes the TAP stream itself, so there is no plan and no `not ok` at
  // all: the diagnostics above are the whole log. The README called this one out as
  // falling back to raw output, and the fallback read `shop.t (Wstat: 512 Tests: 3
  // Failed: 2)` - a line naming no test, no location and no expectation.
  { file: "perl_prove_default_fail.txt", tool: "tap", n: 2, check: (r) => {
      assert.deepEqual(r.failures.map((f) => f.title), ["invoice total", "code matches"]);
      assert.deepEqual(r.failures.map((f) => f.line), [5, 7]);
      assert.equal(r.failures[0].message, "expected '1050', got '1049'");
      // With no plan to count from, saying "0 passed" because nothing printed `ok` is a
      // claim about the run, and a false one - Test::More's epilogue says 2 of 3.
      assert.equal(r.summary, "2 failed, 1 passed", "the epilogue says how many ran");
      assert.doesNotMatch(JSON.stringify(r.failures), /Dubious|subtests|Wstat/);
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
  const quiet = analyse(fx("perl_prove_default_fail.txt"));
  const facts = (r) => r.failures.map((f) => [f.file, f.line, f.title, f.message]);
  assert.deepEqual(facts(prove), facts(raw), "prove -v and raw TAP disagree about one suite");
  // One run, recorded three ways. The third has none of TAP's structure - no plan, no
  // results - and still has to arrive at the same facts and the same tally.
  assert.deepEqual(facts(quiet), facts(raw), "plain prove and raw TAP disagree about one suite");
  assert.equal(quiet.summary, raw.summary, "and disagree about how many ran");
  console.log("  ok   raw TAP, prove -v and plain prove say the same thing");
  pass++;
} catch (e) { console.log(`  FAIL prove -v vs raw TAP\n       ${e.message}`); fail++; }

// Test::More does not make a test's name unique, and prove prints its diagnostics away
// from the results, so the name is the only thing tying the two together. Two failing
// tests that share one has to consume one diagnostic each: taking the same one twice
// leaves the other unclaimed, and it is then reported a second time as a leftover.
// dedupeFailures collapses the identical pair out of the list, so what this shows up in
// is the tally - "4 failed" for a suite of two.
try {
  const log = [
    "",
    "#   Failed test 'totals'",
    "#   at shop.t line 5.",
    "#          got: '1'",
    "#     expected: '2'",
    "",
    "#   Failed test 'totals'",
    "#   at shop.t line 9.",
    "#          got: '3'",
    "#     expected: '4'",
    "# Looks like you failed 2 tests of 2.",
    "shop.t .. ",
    "1..2",
    "not ok 1 - totals",
    "not ok 2 - totals",
    "Dubious, test returned 2 (wstat 512, 0x200)",
    "",
  ].join("\n");
  const r = analyse(log);
  assert.equal(r.tool, "tap");
  assert.equal(r.summary, "2 failed, 0 passed", "a suite of two cannot fail four times");
  assert.deepEqual(r.failures.map((f) => f.line), [5, 9], "each result takes its own diagnostic");
  console.log("  ok   two failing tests sharing a name take one diagnostic each");
  pass++;
} catch (e) { console.log(`  FAIL duplicate test names\n       ${e.message}`); fail++; }

// A log can hold a plain `prove` run and a TAP stream, in that order - two steps of one
// CI job, or a pasted scrollback. prove's diagnostics are read after the stream's results
// because nothing claimed them until then, and reporting them in that order tells the
// reader the second thing happened first.
try {
  const r = analyse([
    "",
    "#   Failed test 'alpha'",
    "#   at a.t line 3.",
    "#          got: '1'",
    "#     expected: '2'",
    "# Looks like you failed 1 test of 1.",
    "a.t .. ",
    "Dubious, test returned 1 (wstat 256, 0x100)",
    "1..1",
    "not ok 1 - beta",
    "#   Failed test 'beta'",
    "#   at b.t line 4.",
    "#          got: '3'",
    "#     expected: '4'",
    "",
  ].join("\n"));
  assert.deepEqual(r.failures.map((f) => `${f.file}:${f.line}`), ["a.t:3", "b.t:4"],
    "failures come back in the order the log tells them");
  console.log("  ok   a leftover diagnostic keeps its place in the log");
  pass++;
} catch (e) { console.log(`  FAIL leftover ordering\n       ${e.message}`); fail++; }

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
