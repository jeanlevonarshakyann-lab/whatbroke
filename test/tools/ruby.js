// Ruby: rspec, ruby, rubocop.
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
  { file: "rspec_load_fail.txt", tool: "rspec", n: 1, check: (r) => {
      // A spec file that raises while loading never becomes a numbered example, so it
      // is reported as prose above the tally instead.
      assert.equal(r.failures[0].file, "./spec/crash_spec.rb");
      assert.equal(r.failures[0].line, 1);
      assert.match(r.failures[0].message, /spec file blew up at load/);
      // and "0 examples, 0 failures" alone reads like success
      assert.match(r.summary, /1 error occurred outside of examples/);
    } },
  // One real rubocop 1.50 run - six offenses over two files, none of them an error - in
  // ten formats. progress, clang and emacs were read. simple, quiet, json, junit, github
  // and markdown came back with nothing, and tap was claimed by the TAP parser as two
  // failures named after the files, with nothing in them.
  ...["progress_same", "clang", "emacs", "simple", "quiet", "tap", "json", "junit", "github"].map((form) => ({
    file: `rubocop_${form}_fail.txt`, tool: "rubocop", n: 6, check: (r) => {
      assert.deepEqual(r.failures.map((f) => [f.file.split("/").pop(), f.line, f.col, f.code]).sort(), [
        ["cart.rb", 3, 11, "Layout/SpaceInsideParens"], ["cart.rb", 3, 17, "Layout/SpaceInsideParens"],
        ["cart.rb", 4, 13, "Style/SymbolProc"], ["cart.rb", 7, 21, "Style/NilComparison"],
        ["checkout.rb", 4, 13, "Lint/AssignmentInCondition"], ["checkout.rb", 6, 3, "Layout/EmptyLineAfterGuardClause"],
      ].sort());
      // The machine formats put the cop in front of the message, where the text puts it in
      // its own place.
      assert.ok(r.failures.every((f) => !f.message.startsWith(f.code)), JSON.stringify(r.failures[0]));
      assert.equal(r.summary, "6 problems");
    } })),
  // markdown prints no column, so the two offenses on line 3 are one line saying one thing.
  { file: "rubocop_markdown_fail.txt", tool: "rubocop", n: 5, check: (r) => {
      assert.deepEqual(r.failures.map((f) => [f.line, f.col, f.code]), [
        [3, undefined, "Layout/SpaceInsideParens"], [4, undefined, "Style/SymbolProc"], [7, undefined, "Style/NilComparison"],
        [4, undefined, "Lint/AssignmentInCondition"], [6, undefined, "Layout/EmptyLineAfterGuardClause"],
      ]);
      assert.equal(r.summary, "6 problems", "rubocop's own count");
    } },
  // Ruby names the method between the location and the message, so there is no space
  // after the line number and nothing recognised it at all. It was read as a guess for a
  // while, which found the file and the line; a parser also gets the exception class,
  // which is the handle you would search for, and keeps the unwind.
  { file: "ruby_error_fail.txt", tool: "ruby", n: 1, check: (r) => {
      assert.equal(r.failures[0].file, "bad.rb");
      assert.equal(r.failures[0].line, 2);
      assert.match(r.failures[0].message, /undefined method .no_such_method./);
      assert.equal(r.failures[0].code, "NoMethodError");
      assert.doesNotMatch(r.failures[0].message, /NoMethodError/, "the class was left in the message too");
      // `trace` is rendered as text, one frame per line. Asserting only its length let a
      // version through that put objects in it, and every frame printed as
      // "at [object Object]" - which only running the CLI showed.
      assert.deepEqual(r.failures[0].trace, ["f (bad.rb:2)", "<main> (bad.rb:4)"]);
    } },
  // Captured on the system ruby, 2.6.10.
  { file: "ruby_keyerror_fail.txt", tool: "ruby", n: 1, check: (r) => {
      assert.equal(r.failures[0].file, "deep.rb");
      assert.equal(r.failures[0].line, 3);
      assert.equal(r.failures[0].code, "KeyError");
      assert.equal(r.failures[0].message, "key not found: :price");
      assert.deepEqual(r.failures[0].trace, [
        "fetch (deep.rb:3)", "block in total (deep.rb:3)", "map (deep.rb:3)", "total (deep.rb:3)",
      ], "the unwind through map and total is the story");
      assert.ok(r.failures[0].trace.every((t) => typeof t === "string"), "trace must render as text");
    } },
  { file: "ruby_nomethod_fail.txt", tool: "ruby", n: 1, check: (r) => {
      // Ruby offers a correction under a NameError, and it is the answer often enough
      // to be worth keeping beside the message.
      assert.match(r.failures[0].message, /Did you mean\? case/);
    } },
  { file: "ruby_syntax_fail.txt", tool: "ruby", n: 1, check: (r) => {
      // A file that will not parse never runs, so there is no exception and no unwind.
      assert.equal(r.failures[0].file, "syn.rb");
      assert.equal(r.failures[0].line, 3);
      assert.equal(r.failures[0].code, undefined);
      assert.match(r.failures[0].message, /^syntax error/);
    } },
  { file: "ruby_require_fail.txt", tool: "ruby", n: 1, check: (r) => {
      // A failing `require` is raised inside rubygems, so the deepest frame is the
      // stdlib. Reporting kernel_require.rb:54 is true and useless; the line that
      // asked for the gem is the one to open.
      assert.equal(r.failures[0].file, "ld.rb");
      assert.equal(r.failures[0].line, 1);
      assert.equal(r.failures[0].code, "LoadError");
      assert.match(r.failures[0].message, /cannot load such file -- definitely_not_a_gem_xyz/);
      // both rubygems frames are counted, not listed: none of them is yours
      assert.deepEqual(r.failures[0].trace, ["<main> (ld.rb:1)"]);
      assert.equal(r.failures[0].hiddenFrames, 2);
    } },
  // Captured with rubocop 1.91 and golangci-lint on Debian - the two linters a Ruby and
  // a Go CI job most often fail on. rubocop had no parser at all; golangci-lint was
  // being read by go's, which called its findings "compile errors" from `go build`.
  { file: "rubocop_fail.txt", tool: "rubocop", n: 13, check: (r) => {
      assert.equal(r.failures[0].file, "app.rb");
      assert.equal(r.failures[0].col, 1, "the fallback dropped the column");
      assert.equal(r.failures[0].code, "Style/FrozenStringLiteralComment");
      // "[Correctable]" is rubocop saying -a would fix it, not part of what is wrong.
      assert.doesNotMatch(JSON.stringify(r.failures), /Correctable/);
      assert.equal(r.failures[0].stmt, "def calculate( x )");
      // rubocop's own tally for this run is "13 offenses detected".
      assert.equal(r.summary, "13 problems");
    } },
  { file: "rubocop_syntax_fail.txt", tool: "rubocop", n: 1, check: (r) => {
      assert.equal(r.failures[0].code, "Lint/Syntax");
      assert.equal(r.failures[0].line, 2);
      // The line under this offence is a note about the parser version, not the source.
      // Only a caret line says the line above it is source, and there is none here.
      assert.equal(r.failures[0].stmt, undefined, "a note about the parser is not the offending line");
    } },
  // One rspec run of four examples - three failing, one pending - in a directory whose
  // name has a space in it, captured in the progress format and in -f json. The document
  // was not read at all. It carries one thing less than the text form and one thing
  // more: no `Failure/Error:` line quoting the example's source, and the exception's
  // class for every failure rather than only for the ones that are not unmet
  // expectations.
  { file: "rspec_text_same_fail.txt", tool: "rspec", n: 3, check: (r) => {
      assert.equal(r.summary, "4 examples, 3 failures, 1 pending");
      assert.deepEqual(r.failures.map((f) => f.line), [2, 3, 2]);
      assert.equal(r.failures[0].file, "./inputs/ruby specs/math failures_spec.rb");
      assert.match(r.failures[0].message, /^it\('adds whole numbers'\)/);
    } },
  { file: "rspec_json_fail.txt", tool: "rspec", n: 3, check: (r) => {
      // the document has no sentence of its own, so one is written from what it counted
      assert.equal(r.summary, "4 examples, 3 failures, 1 pending");
      assert.deepEqual(r.failures.map((f) => f.subject), ["math failures adds whole numbers",
        "math failures compares labels", "runtime states raises unexpectedly"]);
      // the line that raised, from the backtrace - not the line the example opens on
      assert.deepEqual(r.failures.map((f) => f.line), [2, 3, 2]);
      assert.equal(r.failures[0].file, "./inputs/ruby specs/math failures_spec.rb");
      assert.equal(r.failures[0].message, "expected: 5\ngot: 4\n(compared using ==)");
      // an unmet expectation is its message; anything else is named by its class first
      assert.equal(r.failures[2].message, "ArgumentError:\nfixture exploded");
      // the pending example is not a failure
      assert.doesNotMatch(JSON.stringify(r.failures), /is not implemented yet/);
    } },
  { file: "rspec_fail.txt", tool: "rspec", n: 2, check: (r) => {
      assert.equal(r.summary, "3 examples, 2 failures");
      assert.equal(r.failures[0].title, "shop totals an invoice");
      assert.equal(r.failures[0].file, "./spec/shop_spec.rb");
      assert.equal(r.failures[0].line, 7);
      // the KeyError frame list has two entries; the deepest user line wins
      assert.equal(r.failures[1].line, 12);
      assert.match(r.failures[1].message, /key not found: "exp"/);
    } },
  { file: "rspec_profile_fail.txt", tool: "rspec", n: 1, check: (r) => {
      // real rspec run of piotrmurach/tty-color with the default colour mode changed.
      // Two bugs this caught: the summary was rebuilt from the numbers and so always
      // said "failures", where rspec itself writes "1 failure"; and rspec prints its
      // profiling block between the failures and "Finished in", so "Top 2 slowest
      // examples" was absorbed into the last failure's message.
      assert.equal(r.summary, "60 examples, 1 failure");
      const f = r.failures[0];
      assert.equal(f.file, "./spec/unit/mode_spec.rb");
      assert.equal(f.line, 16);
      assert.match(f.message, /expected: 8/);
      assert.match(f.message, /got: 16/);
      assert.ok(!/slowest|seconds average/.test(f.message),
        "profiling output must not land inside a failure");
    } },
];

let pass = 0, fail = 0;
for (const result of [runCases(CASES), agreeAcrossFormats([
  // rspec's text reporters quote the failing example's source on a `Failure/Error:`
  // line; -f json carries no such thing, so the message is the one field that cannot
  // match. What it does carry is checked below, where the two are compared line by line.
  ["rspec", ["rspec_text_same_fail.txt", "rspec_json_fail.txt"], ["message"]],
  // rubocop's text formats print a message without the backticks its machine formats keep:
  // "Pass &:price as an argument to sum" against "Pass `&:price` as an argument to `sum`".
  ["rubocop text", ["rubocop_progress_same_fail.txt", "rubocop_clang_fail.txt", "rubocop_simple_fail.txt",
    "rubocop_quiet_fail.txt", "rubocop_tap_fail.txt"]],
  ["rubocop machine", ["rubocop_emacs_fail.txt", "rubocop_json_fail.txt", "rubocop_junit_fail.txt",
    "rubocop_github_fail.txt"]],
  ["rubocop text and machine", ["rubocop_progress_same_fail.txt", "rubocop_json_fail.txt"], ["message"]],
])]) {
  pass += result.pass;
  fail += result.fail;
}


// ...and where a format is silent about the message, that silence has a shape. rspec's
// -f json drops exactly one line: the `Failure/Error:` line quoting the example's
// source, which no reporter puts in the document. Everything under it is the same.
try {
  const text = analyse(fx("rspec_text_same_fail.txt")).failures;
  const json = analyse(fx("rspec_json_fail.txt")).failures;
  assert.equal(text.length, json.length);
  for (let i = 0; i < text.length; i++) {
    const [quoted, ...rest] = text[i].message.split("\n");
    assert.match(quoted, /^it\(/, "the dropped line is the one quoting the source");
    assert.equal(json[i].message, rest.join("\n"),
      `${json[i].subject}: the document says something else under the quoted line`);
  }
  console.log("  ok   rspec -f json drops the quoted source line and nothing else");
  pass++;
} catch (e) {
  console.log(`  FAIL rspec message silence\n       ${e.message}`);
  fail++;
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
