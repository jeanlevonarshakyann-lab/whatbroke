// Ruby: minitest, rspec, ruby, rubocop.
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
  // Captured with minitest 5.11.3 on Ruby 2.6. minitest is Ruby's own test framework and
  // what a Rails application runs; its run read as a guess with no test names and no
  // locations - "1) Error:" and a bare KeyError, with the assertion's own numbers lost.
  { file: "minitest_fail.txt", tool: "minitest", n: 2, check: (r) => {
      assert.equal(r.summary, "3 runs, 2 assertions, 1 failures, 1 errors, 0 skips");
      // An error says where it is in its backtrace; an assertion says so in brackets.
      const [error, failure] = r.failures;
      assert.deepEqual([error.subject, error.file, error.line], ["ShopTest#test_reads_the_expiry", "shop_test.rb", 14]);
      assert.equal(error.message, 'KeyError: key not found: "exp"');
      assert.deepEqual([failure.subject, failure.file, failure.line], ["ShopTest#test_totals_an_invoice", "shop_test.rb", 9]);
      assert.equal(failure.message, "Expected: 1050\n  Actual: 1049");
      assert.equal(r.guessed, undefined);
    } },
  // -v names each test as it runs; rake runs the same file from a task, which makes every
  // path absolute and adds its own "rake aborted!" after the tally. One run, three ways.
  { file: "minitest_verbose_fail.txt", tool: "minitest", n: 2, check: (r) => {
      assert.deepEqual(r.failures.map((f) => f.subject),
        ["ShopTest#test_reads_the_expiry", "ShopTest#test_totals_an_invoice"]);
      assert.doesNotMatch(JSON.stringify(r.failures), /= 0\.00 s =/, "the verbose run's ticker is not a failure");
    } },
  { file: "minitest_rake_fail.txt", tool: "minitest", n: 2, check: (r) => {
      assert.deepEqual(r.failures.map((f) => f.line), [14, 9]);
      assert.equal(r.failures[0].file, "/home/dev/shop/shop_test.rb");
      // rake says the command failed after the tally, which says nothing the tally did not
      assert.doesNotMatch(JSON.stringify(r), /rake aborted/);
    } },
  // A second run: an assertion over two long strings, which minitest reports as a diff; a
  // `flunk`; an `assert_raises` that raised nothing; a skip, which is not a failure; and an
  // error raised in lib/, where the backtrace's first frame of yours is not the test.
  { file: "minitest_invoice_fail.txt", tool: "minitest", n: 4, check: (r) => {
      assert.equal(r.summary, "5 runs, 3 assertions, 3 failures, 1 errors, 1 skips");
      assert.deepEqual(r.failures.map((f) => f.subject), [
        "InvoiceTest#test_gives_up", "InvoiceTest#test_refuses_an_empty_invoice",
        "InvoiceTest#test_renders_every_line", "InvoiceTest#test_totals_with_quantity"]);
      assert.equal(r.failures[0].message, "rounding is not decided");
      assert.equal(r.failures[1].message, "ArgumentError expected but nothing was raised.");
      assert.match(r.failures[2].message, /^--- expected\n\+\+\+ actual\n/);
      assert.match(r.failures[2].message, /-cake: 4"\n\+cake: 5"$/);
      // the exception was raised in lib/, and that is where it says it is
      assert.deepEqual([r.failures[3].file, r.failures[3].line], ["/home/dev/shop/lib/invoice.rb", 7]);
      assert.deepEqual(r.failures[3].trace, [
        "fetch (/home/dev/shop/lib/invoice.rb:7)", "block in total (/home/dev/shop/lib/invoice.rb:7)",
        "sum (/home/dev/shop/lib/invoice.rb:7)", "total (/home/dev/shop/lib/invoice.rb:7)"]);
      assert.doesNotMatch(JSON.stringify(r.failures), /waiting on the tax rules/, "a skip is not a failure");
    } },
  { file: "minitest_invoice_verbose_fail.txt", tool: "minitest", n: 4, check: (r) => {
      // --verbose prints the skip as a numbered block of its own, between the failures
      assert.deepEqual(r.failures.map((f) => f.subject), [
        "InvoiceTest#test_gives_up", "InvoiceTest#test_refuses_an_empty_invoice",
        "InvoiceTest#test_renders_every_line", "InvoiceTest#test_totals_with_quantity"]);
      assert.doesNotMatch(JSON.stringify(r.failures), /waiting on the tax rules/);
    } },
  // An exception raised inside the standard library: the frames there are not yours, so the
  // failure is at the first frame that is - the test - and the rest are counted.
  { file: "minitest_stdlib_fail.txt", tool: "minitest", n: 1, check: (r) => {
      assert.deepEqual([r.failures[0].file, r.failures[0].line], ["test/config_test.rb", 6]);
      assert.match(r.failures[0].message, /^JSON::ParserError: /);
      assert.deepEqual(r.failures[0].trace, ["test_reads_the_config (test/config_test.rb:6)"]);
      assert.equal(r.failures[0].hiddenFrames, 2);
      assert.doesNotMatch(JSON.stringify(r.failures), /Ruby\.framework/, "the standard library's frames are counted, not shown");
    } },
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
  // Captured with rubocop 1.91 on Ruby 4.0.7. A syntax offence carries the parser it
  // used on a second line, and GitHub's command syntax cannot hold a newline - so rubocop
  // encodes it as %0A. Decoded, the message spans two lines, the cop-name pattern could
  // not reach past the first, and a rubocop log is claimed by whether any offence was
  // read at all: one multi-line message made the whole run read as nothing.
  { file: "rubocop_github_multiline_fail.txt", tool: "rubocop", n: 2, check: (r) => {
      assert.deepEqual(r.failures.map((f) => [f.file, f.line, f.col]), [["shop.rb", 1, 7], ["shop.rb", 6, 1]]);
      assert.equal(r.failures[0].code, "Lint/Syntax");
      // the whole message, as the JSON format gives it for the same run
      assert.equal(r.failures[0].message,
        "class or module name must be a constant literal\n(Using Ruby 2.7 parser; configure using `TargetRubyVersion` parameter, under `AllCops`)");
      assert.doesNotMatch(JSON.stringify(r.failures), /%0A|::error/);
    } },
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
  // One minitest run, three ways of running it. rake writes absolute paths.
  ["minitest", ["minitest_fail.txt", "minitest_verbose_fail.txt", "minitest_rake_fail.txt"]],
  ["minitest with a skip", ["minitest_invoice_fail.txt", "minitest_invoice_verbose_fail.txt"]],
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

// A CI job kills a suite, or a byte cap trips, and a minitest block arrives without the
// tally that ends the run - with whatever the job printed next right below it. The blank
// line minitest ends every block with is what stops the block there.
try {
  // everything up to the last block's last line, which minitest follows with a blank line
  const block = fx("minitest_fail.txt").split("\n").slice(0, 18).join("\n");
  const after = "src/app.py:3: error: Name \"x\" is not defined  [name-defined]\nFound 1 error in 1 file (checked 1 source file)\n";
  const r = analyse(`${block}\n\n${after}`);
  assert.equal(r?.tool, "mypy", "the tool that finished is the one that owns the log");
  const minitest = (r.others ?? []).find((o) => o.tool === "minitest");
  assert.ok(minitest, "the cut-off minitest blocks are still read");
  assert.equal(minitest.failures.length, 2);
  assert.equal(minitest.failures[1].message, "Expected: 1050\n  Actual: 1049");
  assert.doesNotMatch(JSON.stringify(minitest.failures), /name-defined|Found 1 error/,
    "the block ran on into what the job printed next");
  console.log("  ok   a minitest block cut off from its tally stops where minitest ended it");
  pass++;
} catch (e) { console.log(`  FAIL minitest block without its tally\n       ${e.message}`); fail++; }

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
