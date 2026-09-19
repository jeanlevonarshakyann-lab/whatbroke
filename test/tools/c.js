// C, C++ and Swift: clang, gcc, swiftc, cmake, make.
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
  // Captured with Swift 6.2.3 on macOS. `swift test` runs XCTest and swift-testing, and a
  // package may hold tests of both; each library writes its failures its own way, and a run
  // of either read as a guess: the location survived, the test's name did not.
  { file: "swifttest_fail.txt", tool: "swift test", n: 3, check: (r) => {
      assert.equal(r.summary, "Executed 4 tests, with 3 failures (1 unexpected)");
      assert.deepEqual(r.failures.map((f) => f.subject), [
        "ShopTests.InvoiceTests.testRefusesAMissingLine",
        "ShopTests.InvoiceTests.testSaysWhyItGaveUp",
        "ShopTests.InvoiceTests.testTotalsAnInvoice"]);
      assert.deepEqual(r.failures.map((f) => f.line), [21, 25, 16]);
      assert.equal(r.failures[2].file, "/home/dev/shop/Tests/ShopTests/InvoiceTests.swift");
      assert.equal(r.failures[2].message, 'XCTAssertEqual failed: ("1049") is not equal to ("1050")');
      // XCTFail writes "failed - " in front of the message it was given
      assert.equal(r.failures[1].message, "rounding is not decided");
      // the test is named once, as the failure's subject, and not again inside its message
      assert.doesNotMatch(JSON.stringify(r.failures.map((f) => f.message)), /-\[ShopTests/);
    } },
  // swift-testing writes each issue under the test it belongs to, with the comment the
  // expectation was given on the line below. XCTest prints a tally of its own even where no
  // test of its kind ran, and "Executed 0 tests, with 0 failures" is not this run's headline.
  { file: "swifttest_testing_fail.txt", tool: "swift test", n: 3, check: (r) => {
      assert.equal(r.summary, "3 tests in 1 suite failed with 3 issues");
      assert.deepEqual(r.failures.map((f) => [f.subject, f.file, f.line, f.col]), [
        ["totalsAnInvoice()", "CheckoutTests.swift", 6, 5],
        ["roundsUp()", "CheckoutTests.swift", 16, 9],
        ["namesTheShop()", "CheckoutTests.swift", 11, 5]]);
      assert.equal(r.failures[1].message, "Expectation failed: (Invoice(lines: [1], tax: 0).total() → 1) == 2\nrounding is not decided");
    } },
  { file: "swifttest_both_fail.txt", tool: "swift test", n: 6, check: (r) => {
      // one run of a package holding tests of both kinds: each library counts its own
      assert.equal(r.summary, "Executed 4 tests, with 3 failures (1 unexpected) — 3 tests in 1 suite failed with 3 issues");
      assert.equal(r.failures.filter((f) => f.subject.startsWith("ShopTests.")).length, 3);
      assert.equal(r.failures.filter((f) => f.subject.endsWith("()")).length, 3);
    } },
  // A test that crashes ends the run: it never finishes, the runtime says what it hit, and
  // swiftpm reports the signal. The test that died is the failure; the runtime's own frame,
  // in Swift's standard library, is nobody's code.
  { file: "swifttest_crash_fail.txt", tool: "swift test", n: 1, check: (r) => {
      assert.equal(r.failures[0].subject, "ShopTests.InvoiceTests.testReadsALineThatIsNotThere");
      assert.equal(r.failures[0].message, "Fatal error: Index out of range");
      assert.equal(r.failures[0].file, undefined);
      assert.doesNotMatch(JSON.stringify(r.failures), /ContiguousArrayBuffer/);
    } },
  // Captured with CMake 4.4 and ninja 1.13. ninja gets no parser on purpose: what fails
  // under it is a compiler, which already has one, and its own "FAILED: [code=1]" line
  // restates the failure without adding to it - exactly as make's exit line does. make
  // has a parser only for the failures make itself raises; see make_separator_fail.
  { file: "cmake_configure_fail.txt", tool: "cmake", n: 2, check: (r) => {
      assert.equal(r.failures[0].file, "CMakeLists.txt");
      assert.equal(r.failures[0].line, 3);
      assert.equal(r.failures[0].code, "add_executable", "the command that raised it is the closest thing to a code");
      assert.match(r.failures[0].message, /Cannot find source file/);
      assert.match(r.failures[0].message, /missing_source\.c/);
    } },
  { file: "cmake_syntax_fail.txt", tool: "cmake", n: 1, check: (r) => {
      // A parse error in the script names no command at all.
      assert.equal(r.failures[0].line, 2);
      assert.equal(r.failures[0].code, undefined);
      assert.match(r.failures[0].message, /Parse error\.\s+Function missing ending/);
    } },
  { file: "ninja_compile_fail.txt", tool: "clang", n: 2, check: (r) => {
      assert.match(r.failures[0].file, /main\.c$/);
      assert.doesNotMatch(JSON.stringify(r.failures), /FAILED: \[code=1\]|ninja: Entering/,
        "ninja's own lines restate the failure without adding to it");
    } },
  // Captured from Apple Swift 6.x. swiftc writes clang's diagnostic shape and then draws
  // the source underneath it - a numbered echo, and an annotation hanging off the column
  // that repeats the message word for word. Only the header is the diagnostic; reading
  // the annotation too reported four errors for two.
  { file: "swiftc_fail.txt", tool: "swift", n: 2, check: (r) => {
      assert.equal(r.failures[0].file, "mixed.swift");
      assert.equal(r.failures[0].line, 10);
      assert.equal(r.failures[0].col, 14);
      assert.match(r.failures[0].message, /cannot convert value of type 'String'/);
      // the echoed source is the line the diagnostic points at, not the one beside it
      assert.equal(r.failures[0].stmt, 'let x: Int = "hello"');
      assert.match(r.failures[1].message, /cannot find 'y' in scope/);
      // the warning is counted, not reported: it did not fail the build
      assert.equal(r.summary, "2 errors, 1 warning");
      assert.doesNotMatch(JSON.stringify(r.failures), /never used/, "a warning was reported as a failure");
      // the diagnostic group is the handle you would silence or search for
      assert.doesNotMatch(JSON.stringify(r.failures), /\[#/, "the group tag stayed in the message");
    } },
  // A conformance error is the case that produces the most notes, and swiftc 6 draws all
  // of them inside the gutter annotation rather than as standalone "file:line: note:"
  // headers. Three notes here, and none of them is a failure.
  { file: "swiftc_conformance_fail.txt", tool: "swift", n: 1, check: (r) => {
      assert.match(r.failures[0].message, /^type 'Invoice' does not conform to protocol 'Payable'$/);
      assert.equal(r.failures[0].line, 5);
      assert.doesNotMatch(JSON.stringify(r.failures), /note:/, "an annotation note was read as a failure");
      assert.doesNotMatch(JSON.stringify(r.failures), /add stubs for conformance/);
    } },
  { file: "swiftc_bulk_fail.txt", tool: "swift", n: 9, check: (r) => {
      // Eight assignments of the same wrong type, and one unrelated error. That is one
      // cause with eight sites, not nine things to read - but the eight were listed one
      // by one, four of them behind a "... 4 more".
      //
      // The cluster key drops the echoed source line when the failure carries a `code`,
      // because for a compiler the statement is the INSTANCE. swiftc gives no code for
      // these, so the key kept "let v1: Int = ..." and every one of them was unique.
      // The rule is about being a compiler, not about the tool having handed out a code:
      // clang got the right answer only because it happens to set no stmt at all.
      const reported = r.clusters.filter((c) => c.reported);
      assert.equal(reported.length, 1, "eight identical type errors are one cause");
      assert.equal(reported[0].size, 8);
      // and the unrelated one is not swept in with them
      const alone = r.clusters.find((c) => c.size === 1);
      assert.ok(alone, "the lone 'cannot find in scope' error must stay separate");
      assert.match(r.failures[alone.exemplar].message, /cannot find 'missingSymbol' in scope/);
    } },
  { file: "swiftc_driver_fail.txt", tool: "swift", n: 1, check: (r) => {
      // swiftc writes a placeholder location rather than none, and doubles the word:
      // "<unknown>:0: error: error opening input file 'nosuch.swift' (...)"
      assert.equal(r.failures[0].file, undefined, "<unknown> is not a file");
      assert.match(r.failures[0].message, /^error opening input file 'nosuch\.swift'/);
      // mypy's "file:line: error:" shape matches "<unknown>:0: error:" exactly, and a
      // mypy run pasted above this claimed it as a type error. mypy reports only Python.
      assert.doesNotMatch(r.failures[0].message, /^error: /, "the doubled word survived");
    } },
  // `swiftc -parseable-output` wraps the ordinary diagnostics in byte-length-framed
  // JSON records. Scanning the escaped text found one fake location inside `"output"`
  // and swallowed the second error into its message.
  { file: "swiftc_parseable_fail.txt", tool: "swift", n: 2, check: (r) => {
      assert.equal(r.summary, "2 errors");
      assert.deepEqual(r.failures.map((f) => [f.file, f.line, f.col]),
        [["bad.swift", 1, 18], ["bad.swift", 2, 1]]);
      assert.deepEqual(r.failures.map((f) => f.stmt),
        ['let count: Int = "wrong"', "missingSymbol()"]);
      assert.doesNotMatch(JSON.stringify(r.failures), /"output"|exit-status|real_pid/);
    } },
  { file: "swiftc_parseable_plain_fail.txt", tool: "swift", n: 2, check: (r) => {
      assert.deepEqual(r.failures.map((f) => [f.file, f.line, f.col]),
        [["bad.swift", 1, 18], ["bad.swift", 2, 1]]);
    } },
  // Captured with GNU make 3.81 driving Apple clang. What fails under make is a
  // compiler, which already has a parser, and `make: *** [bad.o] Error 1` restates that
  // without adding to it - so make's parser declines these logs entirely.
  { file: "make_compile_fail.txt", tool: "clang", n: 3, check: (r) => {
      assert.equal(r.failures[0].file, "bad.c");
      assert.equal(r.failures[0].line, 3);
      assert.equal(r.failures[0].code, "-Wint-conversion");
      assert.doesNotMatch(JSON.stringify(r.failures), /make: \*\*\*/, "make's echo is not a failure");
    } },
  { file: "make_driver_fail.txt", tool: "clang", n: 1, check: (r) => {
      // The driver failed before it could compile anything, so there is no file:line to
      // report - and "no input files" underneath only restates it.
      assert.match(r.failures[0].message, /no such file or directory: 'nonexistent\.c'/);
      assert.equal(r.failures[0].file, undefined);
      assert.equal(r.failures[0].severity, "error");
      assert.doesNotMatch(JSON.stringify(r.failures), /no input files|make: \*\*\*/);
    } },
  // Captured with GNU make 4.4.1 on Debian, and 3.81 on macOS for the two shapes that
  // differ. make ends a line "Stop." when make itself is refusing to continue, and
  // "Error N" when it is only relaying somebody else's exit status - which is the whole
  // basis for what this parser reads. 4.x quotes 'like this' where 3.81 wrote `like
  // this', so both fixtures are kept rather than one being assumed to stand for both.
  { file: "make_separator_fail.txt", tool: "make", n: 1, check: (r) => {
      assert.equal(r.failures[0].file, "Makefile");
      assert.equal(r.failures[0].line, 2);
      assert.equal(r.failures[0].message, "missing separator.");
      assert.equal(r.failures[0].label, "makefile error", "make prints no codes");
    } },
  { file: "make_function_fail.txt", tool: "make", n: 1, check: (r) => {
      assert.equal(r.failures[0].line, 1);
      assert.match(r.failures[0].message, /unterminated call to function/);
    } },
  { file: "make_norule_fail.txt", tool: "make", n: 1, check: (r) => {
      assert.equal(r.failures[0].subject, "missing.o", "the target it could not build");
      assert.match(r.failures[0].message, /needed by 'all'/);
    } },
  { file: "make_norule_bsdquote_fail.txt", tool: "make", n: 1, check: (r) => {
      // GNU make 3.81 writes `missing.o' - a backquote opening a straight quote.
      assert.equal(r.failures[0].subject, "missing.o");
    } },
  { file: "make_command_fail.txt", tool: "make", n: 1, check: (r) => {
      assert.equal(r.failures[0].subject, "this-command-does-not-exist");
      assert.doesNotMatch(JSON.stringify(r.failures), /Error 127/,
        "the exit status make relayed is not a second failure");
    } },
  { file: "make_include_fail.txt", tool: "make", n: 1, check: (r) => {
      // make says it twice: once against the line that included the file, then again as
      // a target it cannot build. The first one knows where the problem is written.
      assert.equal(r.failures[0].file, "Makefile");
      assert.equal(r.failures[0].line, 1);
      assert.equal(r.failures[0].subject, "nope.mk");
    } },
  { file: "make_nested_fail.txt", tool: "clang", n: 1, check: (r) => {
      // gcc's diagnostics share clang's shape, and clang's parser reads them.
      assert.equal(r.failures[0].file, "bad.c");
      // Two levels of make each report the failure on the way up. Reading either as a
      // failure would turn one compiler error into three.
      assert.doesNotMatch(JSON.stringify(r.failures), /make(\[\d+\])?: \*\*\*|Entering directory/,
        "make relaying an exit status upward is not a failure");
    } },
  // One clang run over two files, printed in four of its diagnostic formats. msvc and vi
  // move the location out of the colon shape - `a.c(2,19):` and `a.c +2:19:` - and nothing
  // read either: two errors came back from the generic reader with no file and no line.
  { file: "clang_format_default_fail.txt", tool: "clang", n: 2, check: (r) => {
      assert.deepEqual(r.failures.map((f) => `${f.file}:${f.line}:${f.col}`), ["a.c:2:19", "b.c:4:12"]);
      assert.match(r.summary, /1 warning hidden/);
    } },
  { file: "clang_format_msvc_fail.txt", tool: "clang", n: 2, check: (r) => {
      assert.deepEqual(r.failures.map((f) => `${f.file}:${f.line}:${f.col}`), ["a.c:2:19", "b.c:4:12"]);
      assert.equal(r.failures[1].message, "use of undeclared identifier 'missing_stock'");
      assert.match(r.summary, /1 warning hidden/);
    } },
  // `a.c +2:19: error:` also fits the colon shape - as a file called "a.c +2" - and that
  // reading was refused for not naming a C source, which left the line read by nothing.
  { file: "clang_format_vi_fail.txt", tool: "clang", n: 2, check: (r) => {
      assert.deepEqual(r.failures.map((f) => `${f.file}:${f.line}:${f.col}`), ["a.c:2:19", "b.c:4:12"]);
    } },
  { file: "clang_format_nocaret_fail.txt", tool: "clang", n: 2, check: (r) => {
      assert.deepEqual(r.failures.map((f) => `${f.file}:${f.line}:${f.col}`), ["a.c:2:19", "b.c:4:12"]);
    } },
  { file: "clang_fail.txt", tool: "clang", n: 2, check: (r) => {
      assert.equal(r.failures[0].title, "-Wint-conversion");
      assert.equal(r.failures[0].col, 17);
      // an error with no [-Wflag] must still be clang's, not claimed by mypy
      assert.equal(r.failures[1].title, "error");
      assert.match(r.failures[1].message, /use of undeclared identifier 'y'/);
      assert.equal(r.tool, "clang", "clang output must not be claimed by the mypy parser");
    } },
  { file: "clang_sarif_plain_fail.txt", tool: "clang", n: 2, check: (r) => {
      assert.equal(r.summary, "2 errors — 1 warning hidden");
      assert.deepEqual(r.failures.map((f) => [f.file, f.line, f.col]), [
        ["/home/dev/clang-sarif/broken.c", 4, 15],
        ["/home/dev/clang-sarif/broken.c", 5, 16],
      ]);
    } },
  { file: "clang_sarif_fail.txt", tool: "clang", n: 2, check: (r) => {
      assert.equal(r.summary, "2 errors — 1 warning hidden");
      assert.deepEqual(r.failures.map((f) => [f.file, f.line, f.col]), [
        ["/home/dev/clang-sarif/broken.c", 4, 15],
        ["/home/dev/clang-sarif/broken.c", 5, 16],
      ]);
      assert.doesNotMatch(JSON.stringify(r.failures), /sarif-format-unstable/,
        "Clang's reporter warning is not a compile failure");
    } },
  // Captured with gcc 14 under -fno-show-column, which older gcc did by default. Without
  // the column, `file:line: error: message` is also javac's shape and mypy's - so the
  // filename is what has to identify the compiler, and only C-family sources qualify.
  { file: "gcc_nocolumn_fail.txt", tool: "clang", n: 1, check: (r) => {
      assert.equal(r.failures[0].file, "inc.c");
      assert.equal(r.failures[0].line, 1);
      assert.equal(r.failures[0].col, undefined, "no column was printed; none is invented");
      assert.match(r.failures[0].message, /nope\.h: No such file or directory/);
      // an error that stopped the compile: the label says fatal, the severity says error
      assert.equal(r.failures[0].label, "fatal error");
      assert.equal(r.failures[0].severity, "error");
    } },
  { file: "gcc_nocolumn_multi_fail.txt", tool: "clang", n: 3, check: (r) => {
      assert.deepEqual(r.failures.map((f) => f.line), [2, 3, 4]);
      assert.equal(r.failures.every((f) => f.col === undefined), true);
      assert.equal(r.failures[1].code, "-Wimplicit-function-declaration");
      // gcc repeats the location as a "note" to say it will not warn again. It is not
      // a second failure, and it sits on the same line as the first.
      assert.doesNotMatch(JSON.stringify(r.failures), /reported only once/);
    } },
  // Captured from `make -j2` with two failing compilations, on macOS. Two compilers
  // writing into one pipe interleaved mid-line, and b.c's diagnostic came out with a
  // fragment of a.c's source frame driven through the middle of it:
  //
  //   b.c:1    1 | :21: error: use of undeclared identifier 'alsonope'
  //
  // That line is not recoverable without guessing which bytes are foreign, and nothing
  // here tries. The count is the part of the wreckage that survived: clang writes
  // "1 error generated." once per translation unit, twice here, and every undamaged log
  // in this corpus agrees with that number exactly.
  { file: "make_parallel_shredded_fail.txt", tool: "clang", n: 1, check: (r) => {
      assert.equal(r.failures[0].file, "a.c");
      assert.equal(r.failures[0].line, 1);
      assert.match(r.failures[0].message, /undeclared identifier 'nope'/);
      // The one that matters: the headline does not claim this was the only one.
      assert.equal(r.summary, "1 of the 2 errors clang reported");
      // and the shredded line is not half-read into a failure of its own
      assert.doesNotMatch(JSON.stringify(r.failures), /alsonope/);
    } },
  { file: "clang_bulk_fail.txt", tool: "clang", n: 14, check: (r) => {
      // real clang run over DaveGamble/cJSON after dropping an argument at every
      // call site of one function. One signature, fourteen callers - the clearest
      // case in the suite of many failures being a single thing to fix.
      const reported = r.clusters.filter((c) => c.reported);
      assert.equal(reported.length, 1, "fourteen callers of one function is one cause");
      assert.equal(reported[0].size, 14);
      assert.match(r.failures[0].message, /too few arguments to function call/);
      // clang's note points at the declaration, a DIFFERENT line, so unlike mypy's
      // same-location notes it is a separate remark and must not become a failure
      assert.equal(r.failures.length, 14, "notes must not be counted as errors");
      assert.ok(!r.failures.some((f) => /declared here/.test(f.message)));
    } },
];

let pass = 0, fail = 0;
for (const result of [runCases(CASES), agreeAcrossFormats([
  ["clang formats", ["clang_format_default_fail.txt", "clang_format_msvc_fail.txt",
    "clang_format_vi_fail.txt", "clang_format_nocaret_fail.txt"]],
])]) {
  pass += result.pass;
  fail += result.fail;
}


// gcc writes a missing header as `inc.c:1:10: fatal error: nope.h: No such file or
// directory`, and with -fno-show-column the column goes away - leaving exactly the shape
// make uses for an include it cannot find. make claimed it, and because make's parse
// succeeded where clang's did not, make WON: a C compile error reported as a make failure
// whose subject was "fatal error: nope.h". What tells them apart is that make puts a bare
// filename where gcc puts a severity word, so the middle has to be matched as a name.
try {
  const { EXTRACTORS } = await import("../../src/index.js");
  const gcc = [
    'inc.c:1: fatal error: nope.h: No such file or directory',
    '    1 | #include "nope.h"',
    '      |          ^~~~~~~~',
    'compilation terminated.',
  ].join("\n");
  const make = EXTRACTORS.find((ex) => ex.name === "make");
  assert.equal(make.detect(gcc), false, "make claimed a compiler's diagnostic");
  assert.equal(make.extract(gcc), null);
  assert.notEqual(analyse(gcc).tool, "make");
  console.log("  ok   a compiler's missing header is not read as make's missing include");
  pass++;
} catch (e) { console.log(`  FAIL compiler header vs make include\n       ${e.message}`); fail++; }

// clang's own count is a claim whatbroke can be checked against, so it is. Every log
// where the two agree must keep agreeing, and any log where they do not must say so in
// the headline rather than quietly reporting the smaller number. The disagreement only
// happens on a log something has damaged - `make -j` interleaving two compilers - and
// that is exactly when a confident count is worst.
try {
  let checked = 0;
  for (const file of readdirSync(join(here, "fixtures"))) {
    const raw = fx(file);
    const declared = [...raw.matchAll(/^(?:\d+ warnings? and )?(\d+) errors? generated\.$/gm)]
      .reduce((n, m) => n + Number(m[1]), 0);
    if (!declared) continue;
    const r = analyse(raw);
    if (r?.tool !== "clang") continue;
    checked++;
    if (r.failures.length === declared) continue;
    assert.ok(r.failures.length < declared,
      `${file}: ${r.failures.length} failures over a log clang says had ${declared}`);
    assert.ok(r.summary.includes(String(declared)),
      `${file}: read ${r.failures.length} of ${declared} and the headline does not say so`);
  }
  assert.ok(checked >= 4, `only ${checked} logs carry a clang count`);
  // ...and the count is read from the line clang writes when a file has warnings too,
  // "1 warning and 1 error generated.", which the pattern once did not know. A real
  // capture with one of its two errors lost - as a damaged log loses one - has to say so.
  const damaged = fx("clang_format_default_fail.txt").split("\n")
    .filter((l) => !/^b\.c:4:12: error:/.test(l)).join("\n");
  assert.equal(analyse(damaged).summary, "1 of the 2 errors clang reported — 1 warning hidden");
  console.log(`  ok   clang's own error count is never quietly contradicted (${checked} logs)`);
  pass++;
} catch (e) { console.log(`  FAIL clang count\n       ${e.message}`); fail++; }

// Swift's parseable mode is a byte-length-framed event stream whose finished record
// contains the normal compiler report. Unicode makes character-count framing wrong,
// and parsing the escaped JSON as ordinary text corrupts both location and message.
try {
  const machine = analyse(fx("swiftc_parseable_fail.txt"));
  const text = analyse(fx("swiftc_parseable_plain_fail.txt"));
  const facts = (r) => r.failures.map((f) =>
    [f.file, f.line, f.col, f.title, f.label, f.severity, f.message, f.stmt]);
  assert.equal(machine.tool, text.tool);
  assert.equal(machine.summary, text.summary);
  assert.deepEqual(facts(machine), facts(text),
    "-parseable-output and the human Swift diagnostics disagree");
  console.log("  ok   swiftc -parseable-output says what its text report says");
  pass++;
} catch (e) { console.log(`  FAIL swift parseable vs text\n       ${e.message}`); fail++; }

// Clang's SARIF mode is a different encoding of the same compile. Its driver warning
// and the SARIF container are presentation; file, position, and message must agree with
// the ordinary diagnostics exactly.
try {
  const plain = analyse(fx("clang_sarif_plain_fail.txt"));
  const sarif = analyse(fx("clang_sarif_fail.txt"));
  const facts = (r) => r.failures.map((f) =>
    [f.file, f.line, f.col, f.title, f.label, f.severity, f.message]);
  assert.equal(sarif.tool, plain.tool);
  assert.equal(sarif.summary, plain.summary);
  assert.deepEqual(facts(sarif), facts(plain),
    "-fdiagnostics-format=sarif and ordinary Clang diagnostics disagree");
  assert.equal(analyse('{"version":"2.1.0","runs":[]}'), null,
    "an empty SARIF lookalike produced a Clang failure");
  const foreign = JSON.stringify({ version: "2.1.0", runs: [{
    tool: { driver: { name: "another-tool" } },
    results: [{ level: "error", message: { text: "not Clang's diagnosis" } }],
  }] });
  assert.notEqual(analyse(foreign)?.tool, "clang",
    "Clang claimed a SARIF report produced by another tool");
  console.log("  ok   Clang SARIF says what its text report says");
  pass++;
} catch (e) { console.log(`  FAIL Clang SARIF vs text\n       ${e.message}`); fail++; }

// A crashed Swift test says what the runtime said after it started, and "Fatal error:" is
// what PHP writes too. In a log holding both - a CI job that runs two suites - the crash
// took PHP's words for its own, which test/mixed.js found by pairing every two captures.
try {
  const together = `${fx("php_fatal_fail.txt")}\n${fx("swifttest_crash_fail.txt")}`;
  const r = analyse(together);
  assert.equal(r?.tool, "swift test");
  assert.equal(r.failures.length, 1);
  assert.equal(r.failures[0].message, "Fatal error: Index out of range");
  const php = (r.others ?? []).find((o) => o.tool === "php");
  assert.ok(php, "PHP's own fatal is still read, as the other tool's");
  assert.match(php.failures[0].message, /Call to a member function method\(\) on null/);
  console.log("  ok   a crashed Swift test does not take another tool's fatal error for its own");
  pass++;
} catch (e) { console.log(`  FAIL swift crash beside another fatal\n       ${e.message}`); fail++; }

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
