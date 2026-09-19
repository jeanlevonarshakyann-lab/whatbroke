// Go: go build, go vet, go test in every encoding, golangci-lint.
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
  // One real golangci-lint 2.13 run - five issues from four linters over two files - in
  // each output it has. The text form was read. tab, checkstyle, code-climate, teamcity,
  // json and sarif came back with nothing, and junit-xml as five failures called
  // "Details:".
  ...["text_same", "tab", "checkstyle", "codeclimate", "junit", "teamcity", "json", "sarif"].map((form) => ({
    file: `golangci_${form}_fail.txt`, tool: "golangci-lint", n: 5, check: (r) => {
      assert.deepEqual(r.failures.map((f) => [f.file, f.line, f.code, f.message]).sort(), [
        ["main.go", 10, "errcheck", "Error return value of `f.Close` is not checked"],
        ["main.go", 11, "ineffassign", "ineffectual assignment to total"],
        ["main.go", 13, "govet", 'printf: fmt.Printf format %d has arg "many" of wrong type string'],
        ["store/store.go", 6, "errcheck", "Error return value of `os.Remove` is not checked"],
        ["store/store.go", 9, "unused", "func unusedHelper is unused"],
      ]);
      assert.equal(r.summary, "5 problems");
    } })),
  // Captured with go 1.25. `go vet` prefixes the line when the package will not compile
  // at all, and that prefix defeated the anchor - so a vet run that hit a type error came
  // back as a guess with no location, with the file and line sitting in plain sight
  // inside the message.
  { file: "govet_compile_fail.txt", tool: "go vet", n: 1, check: (r) => {
      assert.equal(r.failures[0].file, "main.go");
      assert.equal(r.failures[0].line, 6);
      assert.equal(r.failures[0].col, 17);
      assert.match(r.failures[0].message, /^cannot use 42 \(untyped int constant\)/);
      assert.doesNotMatch(r.failures[0].message, /^vet: /, "the prefix is not part of the message");
    } },
  { file: "govet_printf_fail.txt", tool: "go build", n: 2, check: (r) => {
      // Vet's own findings are written exactly like a compile error and carry no prefix,
      // so a piped log gives no way to tell them apart. Reported as the compiler's is
      // the honest reading of the text; the prefix above is the one time it does say.
      assert.equal(r.failures[0].line, 9);
      assert.match(r.failures[0].message, /fmt\.Printf call needs 1 arg but has 2 args/);
      assert.match(r.failures[1].message, /format %s has arg 42 of wrong type int/);
    } },
  // ...and `-json` is the one form that does say. The analyzer names itself there, so
  // the finding carries `printf` rather than being read as the compiler's. It is one
  // document PER PACKAGE, concatenated with nothing between them, so a reader that
  // stops at the first would report one package and drop the rest of the run.
  { file: "govet_json_fail.txt", tool: "go vet", n: 2, check: (r) => {
      assert.deepEqual(r.failures.map((f) => f.code), ["printf", "printf"]);
      assert.deepEqual(r.failures.map((f) => f.file),
        ["/home/dev/shop/shop/cart.go", "/home/dev/shop/ship/box.go"]);
      assert.equal(r.failures[0].line, 7);
      assert.equal(r.failures[0].col, 14);
      assert.match(r.summary, /printf/);
    } },
  // A program that crashes outside a test run. Both languages report it the same way -
  // a message, then a stack that is mostly the runtime's own machinery.
  { file: "gopanic_fail.txt", tool: "go", n: 1, check: (r) => {
      // `go run` output has no test tally and no --- FAIL line, so nothing in the
      // detector fired and this produced no diagnosis at all.
      assert.equal(r.summary, "panic");
      assert.equal(r.failures[0].file, "/home/dev/m3/main.go");
      assert.equal(r.failures[0].line, 7);
      assert.match(r.failures[0].message, /index out of range \[5\] with length 0/);
      assert.equal(r.failures[0].category, "runtime");
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
  // Captured on a windows-latest runner with Go 1.22, by running the failures there and
  // taking what Go printed - the runner's own timestamps and ##[error] tags are the log
  // viewer's, not Go's, and are not part of these files. Every other fixture in this
  // suite has unix paths, so nothing exercised the separator Go actually uses on the
  // platform the test matrix has been running on all along.
  { file: "go_windows_build_fail.txt", tool: "go build", n: 4, check: (r) => {
      // `pkg\helper.go` and `.\main.go` - a class written [\w./-] matches neither, so
      // this whole log used to fall through to the generic fallback.
      assert.equal(r.failures[0].file, "pkg\\helper.go");
      assert.equal(r.failures[0].line, 4);
      // `.\` is the same "this directory" prefix as `./` and is dropped the same way.
      assert.equal(r.failures[1].file, "main.go");
      assert.deepEqual(r.failures.map((f) => f.line), [4, 6, 6, 7]);
    } },
  { file: "go_windows_vet_fail.txt", tool: "go vet", n: 2, check: (r) => {
      // Windows spells the prefix `vet.exe: `. Without it both locations were lost and
      // the run came back as one unlocated guess.
      assert.deepEqual(r.failures.map((f) => f.file), ["pkg\\helper.go", "main.go"]);
      assert.doesNotMatch(JSON.stringify(r.failures), /vet\.exe/);
    } },
  { file: "go_windows_test_fail.txt", tool: "go test", n: 2, check: (r) => {
      // go test needed no fixing, and this pins why: the testing package prints a bare
      // basename, and the runtime writes its frames with forward slashes even here.
      assert.equal(r.failures[0].file, "shop_test.go");
      assert.match(r.failures[1].file, /^D:\/a\/.*shop_test\.go$/);
      // The panic unwinds through testing.go and panic.go under a Windows toolchain
      // path; those are Go's frames, not yours.
      assert.doesNotMatch(JSON.stringify(r.failures.map((f) => f.file)), /hostedtoolcache/);
    } },
  { file: "golangci_fail.txt", tool: "golangci-lint", n: 6, check: (r) => {
      // The linter's name is what you would disable, so it is the code rather than
      // being left inside the message where nothing can group on it.
      assert.deepEqual(r.failures.map((f) => f.code),
        ["errcheck", "ineffassign", "revive", "revive", "revive", "revive"]);
      assert.equal(r.failures[0].col, 15);
      assert.doesNotMatch(r.failures[0].message, /\(errcheck\)/);
      assert.equal(r.failures[0].stmt, "defer f.Close()");
    } },
  { file: "golangci_typecheck_fail.txt", tool: "golangci-lint", n: 1, check: (r) => {
      // When the package will not compile, golangci-lint prints go's own diagnostics and
      // tags only the LAST of them "(typecheck)". The other two are go's line for line,
      // so go's parser reads them and they arrive attributed rather than lost.
      assert.equal(r.failures[0].code, "typecheck");
      assert.equal(r.failures[0].line, 7);
      const others = (r.others ?? []).flatMap((o) => o.failures);
      assert.equal(others.length, 2, "the two untagged compile errors are still reported");
      assert.equal((r.others ?? [])[0].tool, "go build");
    } },
  // One run of a Go project, captured plainly and with -v. Verbose output puts a test's
  // lines ABOVE its "--- FAIL" line, frames parallel tests with PAUSE/CONT and switches
  // between them with "=== NAME" - and every failure in a verbose log used to be pinned
  // to the NEXT test's output: TestAdd reported with TestTable/zero's error, and
  // TestTable/zero with TestParallelA's, a passing test's log included.
  { file: "gotest_verbose_fail.txt", tool: "go test", n: 4, check: (r) => {
      assert.deepEqual(r.failures.map((f) => [f.title, f.line]),
        [["TestAdd", 7], ["TestTable/zero", 22], ["TestParallelA", 30], ["TestNilMap", 7]]);
      // TestParallelB passed. Its log line sits between A's two and must not join them.
      assert.doesNotMatch(JSON.stringify(r.failures), /B says hello/);
      // TestTable's own "--- FAIL" carries nothing of its own; the failure is its subtest's.
      assert.ok(!r.failures.some((f) => f.title === "TestTable"));
      // A panic's dump comes after its test's result line, and still belongs to it.
      assert.match(r.failures[3].message, /nil map/);
    } },
  { file: "gotest_verbose_plain_fail.txt", tool: "go test", n: 4, check: (r) => {
      assert.deepEqual(r.failures.map((f) => [f.title, f.line]),
        [["TestAdd", 7], ["TestTable/zero", 22], ["TestParallelA", 30], ["TestNilMap", 7]]);
    } },
  // The same Go project run a third time, under -json: the test2json stream gotestsum and
  // most Go CI keep, which came back as one guess made of raw JSON.
  { file: "gotest_json_fail.txt", tool: "go test", n: 4, check: (r) => {
      assert.deepEqual(r.failures.map((f) => [f.title, f.line]),
        [["TestAdd", 7], ["TestTable/zero", 22], ["TestParallelA", 30], ["TestNilMap", 7]]);
      assert.doesNotMatch(JSON.stringify(r.failures), /"Action"|B says hello/);
    } },
  // One `go test ./...` over a package that will not compile and another whose tests
  // fail - an ordinary invocation, not two glued together - captured plainly, with -v and
  // with -json. Plain and -v reported the compile error and dropped all three tests; -json
  // did the opposite, because go reports a build as "build-output" events.
  { file: "gotest_build_and_tests_fail.txt", tool: "go test", n: 4, check: (r) => {
      assert.deepEqual(r.failures.map((f) => [f.title, f.line]).sort(), [["compile error", 3], ["TestAdd", 7], ["TestTable/zero", 22], ["TestParallelA", 30]].sort());
      assert.equal(r.summary, "1 compile error, 3 tests failed");
    } },
  { file: "gotest_build_and_tests_verbose_fail.txt", tool: "go test", n: 4, check: (r) => {
      assert.deepEqual(r.failures.map((f) => [f.title, f.line]).sort(), [["compile error", 3], ["TestAdd", 7], ["TestTable/zero", 22], ["TestParallelA", 30]].sort());
    } },
  { file: "gotest_build_and_tests_json_fail.txt", tool: "go test", n: 4, check: (r) => {
      assert.deepEqual(r.failures.map((f) => [f.title, f.line]).sort(), [["compile error", 3], ["TestAdd", 7], ["TestTable/zero", 22], ["TestParallelA", 30]].sort());
      assert.equal(r.summary, "1 compile error, 3 tests failed");
    } },
  { file: "gotest_cluster_fail.txt", tool: "go test", n: 7, check: (r) => {
      // real `go test` run of spf13/cobra after renaming one error string.
      // Three tests share one assertion shape; the rest fail differently.
      const reported = r.clusters.filter((c) => c.reported);
      assert.equal(reported.length, 1, "the shared cause should be one cluster");
      assert.equal(reported[0].size, 3);
      assert.match(reported[0].signature, /Expected: <str>, got: <str>/);
      assert.ok(reported[0].members.every((i) => /args_test\.go$/.test(r.failures[i].file)),
        "all three sites are in args_test.go");
      // and the four unrelated failures must NOT have been swept in
      assert.equal(r.clusters.filter((c) => !c.reported).length, 4);
    } },
  { file: "gorace_fail.txt", tool: "go test", n: 3, check: (r) => {
      // real `go test -race`. The detector names the exact line of the racing
      // access - the bug - while the assertion below it only reports a wrong total.
      // Before, the race report was dropped and the output pointed at line 17,
      // the symptom, instead of line 13, the cause.
      assert.equal(r.summary, "1 test failed, 2 data races");
      const races = r.failures.filter((f) => f.title === "DATA RACE");
      assert.equal(races.length, 2);
      assert.equal(races[0].line, 13, "the racing access, not the assertion");
      assert.match(races[0].file, /race_test\.go$/);
      // go writes "Read at" but "Previous write at" - both operations must be named
      assert.match(races[0].message, /Read by goroutine \d+/);
      assert.match(races[0].message, /Previous write by goroutine \d+/i);
      // the ordinary assertion failure is still reported, and still called a test
      const test = r.failures.find((f) => f.title === "TestRace");
      assert.ok(test && test.line === 17, "the assertion failure is still there");
    } },
  // Captured with go 1.27.1. `gofmt -d` is the other half of Go's format gate, and it was
  // read as nothing: the job failed and whatbroke said there was no parser for it. The
  // file is named once in the header and each @@ hunk says where in it.
  { file: "gofmt_fail.txt", tool: "gofmt", n: 2, check: (r) => {
      assert.equal(r.summary, "2 files failed the format check");
      // The line the change starts at, not the hunk's: a hunk opens with up to three
      // unchanged lines of context, and cart.go's first changed line is its third.
      assert.deepEqual(r.failures.map((f) => `${f.file}:${f.line}`),
        ["cart/cart.go:3", "main.go:5"]);
      // The first line it would remove is the source as it stands.
      assert.equal(r.failures[0].stmt, "type Cart struct{");
      assert.equal(r.failures[1].stmt, "func total( items []int ) int {");
    } },
  { file: "gofmt_hunks_fail.txt", tool: "gofmt", n: 2, check: (r) => {
      // One file, two regions: a hunk is a place, which is what the @@ line is for.
      assert.equal(r.summary, "1 file failed the format check");
      assert.deepEqual(r.failures.map((f) => `${f.file}:${f.line}`),
        ["invoice/invoice.go:20", "invoice/invoice.go:31"]);
      assert.equal(r.failures[1].stmt, "return days>30");
    } },
];

let pass = 0, fail = 0;
for (const result of [runCases(CASES), agreeAcrossFormats([
  ["golangci-lint", ["golangci_text_same_fail.txt", "golangci_tab_fail.txt", "golangci_checkstyle_fail.txt",
    "golangci_junit_fail.txt", "golangci_json_fail.txt", "golangci_sarif_fail.txt"]],
  // Code Climate and TeamCity have nowhere to put a column.
  ["golangci-lint no column", ["golangci_text_same_fail.txt", "golangci_codeclimate_fail.txt",
    "golangci_teamcity_fail.txt"], ["col"]],
])]) {
  pass += result.pass;
  fail += result.fail;
}


// go's parser found compile errors and returned, so a stream holding both compile errors
// and a panic reported only the compile errors and dropped the panic without a word.
// `go build ./... ; ./prog` produces exactly that, and so does golangci-lint when the
// package will not compile. Neither of the two sweeps caught it: the cross-parser one
// skips pairs read by one parser, and the same-tool one groups by the tool STRING, where
// these two logs are "go build" and "go".
try {
  const build = fx("gobuild_fail.txt"), panic = fx("gopanic_fail.txt");
  const alone = [analyse(build), analyse(panic)];
  assert.deepEqual(alone.map((r) => r.failures.length), [3, 1]);
  for (const joined of [`${build}\n${panic}`, `${panic}\n${build}`]) {
    const r = analyse(joined);
    assert.equal(r.failures.length, 4, "the panic went missing beside the compile errors");
    assert.equal(r.failures.filter((f) => f.label === "panic").length, 1);
    // and the headline counts it, rather than saying 3 over four failures
    assert.match(r.summary, /and a panic/);
  }
  console.log("  ok   a panic beside compile errors is not dropped by either of them");
  pass++;
} catch (e) { console.log(`  FAIL panic beside compile errors\n       ${e.message}`); fail++; }

// The same Go run captured plainly and with -v has to say the same thing - file, line,
// test and message for every failure. Verbose mode is where a test's output sits above
// its result line, and it is also what every `go test -json` stream runs underneath, so
// this is the check that attribution in that layout is right rather than just different.
try {
  const plain = analyse(fx("gotest_verbose_plain_fail.txt"));
  const verbose = analyse(fx("gotest_verbose_fail.txt"));
  const facts = (r) => r.failures.map((f) => [f.file, f.line, f.title, f.message]);
  assert.deepEqual(facts(verbose), facts(plain), "-v reads a different set of failures from the same run");
  console.log("  ok   go test -v says what plain go test says");
  pass++;
} catch (e) { console.log(`  FAIL go -v vs plain\n       ${e.message}`); fail++; }

// -json is the third encoding of the same run, and has to say the same thing as the
// plain one: file, line, test and message for every failure. The stream is rebuilt into
// the verbose log inside the parser, so this is also the check that the rebuild is exact.
try {
  const plain = analyse(fx("gotest_verbose_plain_fail.txt"));
  const json = analyse(fx("gotest_json_fail.txt"));
  const facts = (r) => r.failures.map((f) => [f.file, f.line, f.title, f.message]);
  assert.deepEqual(facts(json), facts(plain), "-json reads a different set of failures from the same run");
  console.log("  ok   go test -json says what plain go test says");
  pass++;
} catch (e) { console.log(`  FAIL go -json vs plain\n       ${e.message}`); fail++; }

// The same build-and-test run in three encodings has to report the same failures. The
// comparison is of the SET: `go test ./...` runs packages in parallel, so the order their
// output arrives in is not something one run promises another.
try {
  const facts = (r) => r.failures.map((f) => JSON.stringify([f.file, f.line, f.title, f.message])).sort();
  const plain = facts(analyse(fx("gotest_build_and_tests_fail.txt")));
  for (const other of ["gotest_build_and_tests_verbose_fail.txt", "gotest_build_and_tests_json_fail.txt"]) {
    assert.deepEqual(facts(analyse(fx(other))), plain, `${other} reads a different set of failures`);
  }
  console.log("  ok   a package that will not build does not hide the tests that failed, in any encoding");
  pass++;
} catch (e) { console.log(`  FAIL build and tests\n       ${e.message}`); fail++; }

// `--- expected` heads one half of a unified diff, which is what minitest and PHPUnit print
// between two values that differ - and it is the shape of go's own `--- FAIL:` line without
// the word. go claimed five such captures and read nothing from any of them, which is the
// only reason nothing went wrong; a parser that claims a log it cannot read is one change
// away from diagnosing somebody else's failure.
try {
  const { EXTRACTORS } = await import("../../src/index.js");
  const go = EXTRACTORS.find((ex) => ex.name === "go");
  const claimed = [];
  for (const name of ["minitest_invoice_fail.txt", "phpunit_text_same_fail.txt", "phpunit_junit_fail.txt"]) {
    const text = fx(name);
    assert.match(text, /^--- (?:expected|Expected)/m, `${name} no longer holds a diff`);
    if (go.detect(text)) claimed.push(name);
  }
  assert.deepEqual(claimed, [], "go claimed a log whose only dashes are a diff's");
  // and it still claims its own, whichever word follows the dashes
  for (const name of ["gotest_fail.txt", "gotest_verbose_fail.txt"]) {
    assert.equal(go.detect(fx(name)), true, `${name} is go's`);
  }
  console.log("  ok   a diff's `--- expected` is not go's test tally");
  pass++;
} catch (e) { console.log(`  FAIL a diff is not go's tally\n       ${e.message}`); fail++; }

// A gofmt diff ends where its own diff ends. It is not the only thing that draws @@ hunks:
// minitest writes `--- expected` / `+++ actual` / `@@` between two values that differ, and
// so does PHPUnit - so a CI job running gofmt and then a test suite put both in one log.
// Keeping the header's file current for the rest of the log read that suite's diff as more
// unformatted Go, and the pair gained a failure neither half had. test/mixed.js found it
// by pairing every two captures in the corpus.
try {
  const gofmt = fx("gofmt_fail.txt"), minitest = fx("minitest_invoice_fail.txt");
  const count = (r) => (r?.failures.length ?? 0) + (r?.others ?? []).reduce((n, o) => n + o.failures.length, 0);
  const apart = count(analyse(gofmt)) + count(analyse(minitest));
  assert.equal(count(analyse(`${gofmt}\n${minitest}`)), apart,
    "a gofmt diff must not read on into another tool's diff");
  // And the failures are still each tool's own.
  const both = analyse(`${gofmt}\n${minitest}`);
  const tools = new Set([both.tool, ...(both.others ?? []).map((o) => o.tool)]);
  assert.deepEqual([...tools].sort(), ["gofmt", "minitest"]);
  console.log("  ok   a gofmt diff stops where its own diff stops");
  pass++;
} catch (e) { console.log(`  FAIL gofmt diff bound\n       ${e.message}`); fail++; }

// A second tool can insert indented output into a hunk. Those lines look like diff
// context, but cannot move a removed line beyond the hunk's declared old range.
try {
  const clean = fx("gofmt_hunks_fail.txt");
  const interleaved = clean.replace("@@ -17,8 +17,8 @@\n",
    `@@ -17,8 +17,8 @@\n${'    "cell": null,\n'.repeat(11)}`);
  const findings = analyse(interleaved).failures;
  assert.deepEqual(findings.map((f) => [f.file, f.line, f.stmt]),
    [["invoice/invoice.go", 31, "return days>30"]],
    "interleaved context must not invent another finding at the next hunk's location");
  console.log("  ok   interleaved gofmt context stays within its hunk");
  pass++;
} catch (e) { console.log(`  FAIL gofmt interleaving\n       ${e.message}`); fail++; }

// The header has to be "diff <path>.orig <path>" with the SAME path twice. That is what
// keeps gofmt off every other diff a build prints - git's, and a plain `diff a b`, either
// of which it would otherwise read as somebody's unformatted Go.
try {
  const { EXTRACTORS } = await import("../../src/index.js");
  const gofmt = EXTRACTORS.find((e) => e.name === "gofmt");
  const hunk = "@@ -1,4 +1,4 @@\n-old\n+new\n";
  assert.equal(gofmt.detect(`diff --git a/src/main.go b/src/main.go\nindex 1234567..89abcde 100644\n--- a/src/main.go\n+++ b/src/main.go\n${hunk}`), false, "a git diff is not gofmt's");
  assert.equal(gofmt.detect(`diff a.txt b.txt\n${hunk}`), false, "a plain diff is not gofmt's");
  assert.equal(gofmt.detect(`diff x.go.orig y.go\n${hunk}`), false, "two different files are not one file's backup");
  assert.equal(gofmt.detect(`diff x.go.orig x.go\n${hunk}`), true);
  const claimed = readdirSync(join(here, "fixtures")).sort()
    .filter((n) => { try { return gofmt.detect(fx(n)); } catch { return false; } });
  assert.deepEqual(claimed, ["gofmt_fail.txt", "gofmt_hunks_fail.txt"]);
  console.log("  ok   gofmt reads its own diffs and nobody else's");
  pass++;
} catch (e) { console.log(`  FAIL gofmt diff shape\n       ${e.message}`); fail++; }

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
