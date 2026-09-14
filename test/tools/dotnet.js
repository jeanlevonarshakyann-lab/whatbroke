// .NET: dotnet build and dotnet test.
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
  // Build tools fail in ways that have nothing to do with a compiler, and none of these
  // carries a file position for a diagnostic pattern to find.
  { file: "dotnet_noproject_fail.txt", tool: "dotnet", n: 1, check: (r) => {
      assert.equal(r.failures[0].code, "MSB1003");
      assert.equal(r.failures[0].file, undefined, "MSBUILD is the tool speaking, not a file");
      assert.match(r.failures[0].message, /Specify a project or solution file/);
    } },
  // The same failing restore captured twice: as MSBuild prints it, and under .NET 10's
  // Terminal Logger (`--tl:on`), which indents every diagnostic beneath its target and
  // wraps the code in an OSC 8 hyperlink to the docs. The indentation alone meant the
  // project-level pattern - which required the line to begin with the path - matched
  // nothing, so a real NU1101 came back with no diagnosis at all.
  // The compiler half of the same presentation problem. .NET 10 uses the Terminal Logger
  // by default on a terminal, and it indents each diagnostic beneath its target - so the
  // four spaces that hid a project-level error from the other pattern ended up INSIDE the
  // path here, and every file began with them. One real project, built twice.
  { file: "dotnet_terminal_plain_fail.txt", tool: "dotnet", n: 2, check: (r) => {
      assert.deepEqual(r.failures.map((f) => [f.file, f.line, f.col]), [
        ["/home/dev/dotnet-terminal/Broken.cs", 5, 34],
        ["/home/dev/dotnet-terminal/Broken.cs", 6, 35],
      ]);
    } },
  { file: "dotnet_terminal_logger_fail.txt", tool: "dotnet", n: 2, check: (r) => {
      assert.deepEqual(r.failures.map((f) => [f.file, f.line, f.col]), [
        ["/home/dev/dotnet-terminal/Broken.cs", 5, 34],
        ["/home/dev/dotnet-terminal/Broken.cs", 6, 35],
      ], "Terminal Logger indentation leaked into the source path");
    } },
  { file: "dotnet_restore_plain_fail.txt", tool: "dotnet", n: 1, check: (r) => {
      assert.equal(r.failures[0].file, "/home/dev/dotnet-restore/app.csproj");
      assert.equal(r.failures[0].code, "NU1101");
      assert.match(r.failures[0].message, /Unable to find package ThisPackageDoesNotExist\.Xyz/);
    } },
  { file: "dotnet_restore_terminal_fail.txt", tool: "dotnet", n: 1, check: (r) => {
      assert.equal(r.failures[0].file, "/home/dev/dotnet-restore/app.csproj",
        "Terminal Logger indentation leaked into the project path");
      assert.equal(r.failures[0].code, "NU1101", "the OSC 8 hyperlink around the code survived stripping");
    } },
  { file: "dotnet_restore_fail.txt", tool: "dotnet", n: 1, check: (r) => {
      // NuGet prints the same failure once as it happens and again under "Build FAILED."
      assert.equal(r.failures[0].code, "NU1101");
      assert.match(r.failures[0].file, /app\.csproj$/);
      assert.match(r.failures[0].message, /Unable to find package This\.Package\.Does\.Not\.Exist\.Xyz/);
    } },
  { file: "dotnet_fail.txt", tool: "dotnet", n: 2, check: (r) => {
      // dotnet prints each error twice; summary and list must agree
      assert.equal(r.summary, "2 errors");
      assert.equal(r.failures.length, 2);
      assert.equal(r.failures[0].title, "CS0029");
      assert.equal(r.failures[0].line, 5);
      // the trailing [/path/app.csproj] is noise, not part of the message
      assert.ok(!r.failures.some((f) => /csproj/.test(f.message)),
        "the project path must be stripped from the message");
    } },
  // One `dotnet test` run, in its console output and in the trx document a .NET CI job
  // keeps beside it. The document was not read at all. A <TestRun> element on its own is
  // not evidence of anything, so what is required is the namespace it declares.
  // One `dotnet test` run under the SDK's UI languages. Every word VSTest's console writes
  // is translated - "Failed" is "Fehler", "失敗", "Не пройден", "Com falha" - and reading
  // only the English words sent every other language to no diagnosis at all. The failure
  // word is read from the run's own tally instead, and the labels by where they stand.
  // The same run under Microsoft.Testing.Platform, which translates more: the outcome
  // ("fehlerhaft", "operazione non riuscita", "已失敗"), the assembly line under it, the
  // summary, and the stack frames - "um ... in", "場所: ... 場所:". None of it but the
  // English was read. What no language changes is the assembly line with its framework
  // and architecture, and only a failure has a stack under it.
  ...[
    ["dotnettest_mtp_locale_en_fail.txt", "Assert.AreEqual failed. Expected:<6>. Actual:<4>."],
    ["dotnettest_mtp_locale_de_fail.txt", 'Fehler bei "Assert.AreEqual". Erwartet:<6>. Tatsächlich:<4>.'],
    // one word in Japanese, and the frame's two words are the same word with a colon
    ["dotnettest_mtp_locale_ja_fail.txt", "Assert.AreEqual に失敗しました。"],
    // "total" is Spanish too, so reading the English labels first found only that one
    ["dotnettest_mtp_locale_es_fail.txt", "Error de Assert.AreEqual."],
    // the outcome is three words
    ["dotnettest_mtp_locale_it_fail.txt", "Assert.AreEqual non riuscita."],
    // the summary's colon is full-width
    ["dotnettest_mtp_locale_zh_hant_fail.txt", "Assert.AreEqual 失敗。"],
  ].map(([file, said]) => ({ file, tool: "dotnet test", n: 2, check: (r) => {
      assert.deepEqual(r.failures.map((f) => [f.subject, f.file.split("/").pop(), f.line]),
        [["AppliesDiscount", "Test1.cs", 15], ["TotalsAnInvoice", "Test1.cs", 9]]);
      assert.match(r.failures[0].message, /System\.InvalidOperationException: discount table missing/);
      assert.ok(r.failures[1].message.startsWith(said), r.failures[1].message);
      assert.equal(r.summary, "2 failed, 1 passed (3)");
    } })),
  // --output detailed prints the passing test too, with the same assembly line under it.
  { file: "dotnettest_mtp_detailed_de_fail.txt", tool: "dotnet test", n: 2, check: (r) => {
      assert.deepEqual(r.failures.map((f) => f.subject), ["AppliesDiscount", "TotalsAnInvoice"],
        "erfolgreich CountsItems passed, and was read as a failure");
      assert.equal(r.summary, "2 failed, 1 passed (3)");
    } },
  // English, the control
  { file: "dotnettest_locale_en_fail.txt", tool: "dotnet test", n: 3, check: (r) => {
      assert.deepEqual(r.failures.map((f) => f.subject),
        ["ArithmeticTests.Crash", "ArithmeticTests.Addition", "ArithmeticTests.Greeting"]);
      assert.deepEqual(r.failures.map((f) => f.line), [12, 6, 9]);
      assert.equal(r.failures[0].message, "System.InvalidOperationException : fixture exploded");
      assert.equal(r.summary, "3 failed (3)");
    } },
  // German
  { file: "dotnettest_locale_de_fail.txt", tool: "dotnet test", n: 3, check: (r) => {
      assert.deepEqual(r.failures.map((f) => f.subject),
        ["ArithmeticTests.Crash", "ArithmeticTests.Addition", "ArithmeticTests.Greeting"]);
      assert.deepEqual(r.failures.map((f) => f.line), [12, 6, 9]);
      assert.equal(r.failures[0].message, "System.InvalidOperationException : fixture exploded");
      assert.equal(r.summary, "3 failed (3)");
    } },
  // Japanese: the tally separates its counts with an ideographic comma
  { file: "dotnettest_locale_ja_fail.txt", tool: "dotnet test", n: 3, check: (r) => {
      assert.deepEqual(r.failures.map((f) => f.subject),
        ["ArithmeticTests.Crash", "ArithmeticTests.Addition", "ArithmeticTests.Greeting"]);
      assert.deepEqual(r.failures.map((f) => f.line), [12, 6, 9]);
      assert.equal(r.failures[0].message, "System.InvalidOperationException : fixture exploded");
      assert.equal(r.summary, "3 failed (3)");
    } },
  // French: a no-break space before each label's colon
  { file: "dotnettest_locale_fr_fail.txt", tool: "dotnet test", n: 3, check: (r) => {
      assert.deepEqual(r.failures.map((f) => f.subject),
        ["ArithmeticTests.Crash", "ArithmeticTests.Addition", "ArithmeticTests.Greeting"]);
      assert.deepEqual(r.failures.map((f) => f.line), [12, 6, 9]);
      assert.equal(r.failures[0].message, "System.InvalidOperationException : fixture exploded");
      assert.equal(r.summary, "3 failed (3)");
    } },
  // Russian: a failure word of two words, and counts with no colon before them
  { file: "dotnettest_locale_ru_fail.txt", tool: "dotnet test", n: 3, check: (r) => {
      assert.deepEqual(r.failures.map((f) => f.subject),
        ["ArithmeticTests.Crash", "ArithmeticTests.Addition", "ArithmeticTests.Greeting"]);
      assert.deepEqual(r.failures.map((f) => f.line), [12, 6, 9]);
      assert.equal(r.failures[0].message, "System.InvalidOperationException : fixture exploded");
      assert.equal(r.summary, "3 failed (3)");
    } },
  // Portuguese: a two-word failure word, and an en dash after it
  { file: "dotnettest_locale_pt_br_fail.txt", tool: "dotnet test", n: 3, check: (r) => {
      assert.deepEqual(r.failures.map((f) => f.subject),
        ["ArithmeticTests.Crash", "ArithmeticTests.Addition", "ArithmeticTests.Greeting"]);
      assert.deepEqual(r.failures.map((f) => f.line), [12, 6, 9]);
      assert.equal(r.failures[0].message, "System.InvalidOperationException : fixture exploded");
      assert.equal(r.summary, "3 failed (3)");
    } },
  { file: "dotnettest_text_same_fail.txt", tool: "dotnet test", n: 3, check: (r) => {
      assert.deepEqual(r.failures.map((f) => f.subject),
        ["ArithmeticTests.Crash", "ArithmeticTests.Addition", "ArithmeticTests.Greeting"]);
      assert.deepEqual(r.failures.map((f) => f.line), [12, 6, 9]);
      assert.equal(r.summary, "3 failed (3)");
    } },
  { file: "dotnettest_trx_fail.txt", tool: "dotnet test", n: 3, check: (r) => {
      assert.deepEqual(r.failures.map((f) => f.subject),
        ["ArithmeticTests.Crash", "ArithmeticTests.Addition", "ArithmeticTests.Greeting"]);
      // the first frame in your own code, not the reflection frames under it
      assert.deepEqual(r.failures.map((f) => f.line), [12, 6, 9]);
      assert.equal(r.failures[0].file, "/home/dev/shop/UnitTest1.cs");
      assert.equal(r.failures[0].message, "System.InvalidOperationException : fixture exploded");
      // the document prints no tally line, but it counts the same things
      assert.equal(r.summary, "3 failed (3)");
      assert.doesNotMatch(JSON.stringify(r.failures), /StackTrace|MethodBaseInvoker/);
    } },
  { file: "dotnettest_fail.txt", tool: "dotnet test", n: 3, check: (r) => {
      // real `dotnet test` (Microsoft.Testing.Platform + xUnit) on khellang/Scrutor
      // after changing one default lifetime. This output used to fall through to the
      // generic guess: one "error", no test name, no file, no line.
      assert.equal(r.summary, "3 failed, 77 passed (80)");
      const f = r.failures[0];
      assert.equal(f.title, "ScanningTests.AutoRegisterAsMatchingInterface");
      assert.match(f.file, /ScanningTests\.cs$/);
      assert.equal(f.line, 395);
      assert.match(f.message, /Assert\.All\(\) Failure/);
      // the runner prints each message twice, plainly and re-indented under "from"
      assert.equal((f.message.match(/Assert\.All\(\) Failure/g) || []).length, 1,
        "the repeated copy of the message must not be collected");
      // and the location must come from the user's frame, not the reflection runner
      assert.ok(r.failures.every((g) => !/System\.Reflection/.test(g.file ?? "")));
      assert.equal(r.failures[2].line, 152);
    } },
  { file: "dotnettest_vstest_fail.txt", tool: "dotnet test", n: 2, check: (r) => {
      // Real default `dotnet test` output through the VSTest xUnit adapter. It used
      // to become one generic failure whose entire diagnosis was "Error Message:".
      assert.equal(r.summary, "2 failed, 1 passed, 1 skipped (4)");
      assert.equal(r.failures[0].title, "InvoiceTests.MissingCustomer");
      assert.equal(r.failures[0].file, "/home/dev/sample.Tests/UnitTest1.cs");
      assert.equal(r.failures[0].line, 12);
      assert.match(r.failures[0].message, /InvalidOperationException : customer record missing/);
      assert.equal(r.failures[1].title, "InvoiceTests.AddsTax");
      assert.equal(r.failures[1].line, 8);
      assert.match(r.failures[1].message, /Expected: 1050\nActual:[^\S\n]+1049/);
    } },
  { file: "dotnettest_vstest_detailed_fail.txt", tool: "dotnet test", n: 2, check: (r) => {
      assert.equal(r.summary, "2 failed, 1 passed, 1 skipped (4)");
      assert.ok(r.failures.every((f) => f.title !== "InvoiceTests.Skipped"),
        "detailed verbosity's skipped reason became a failure");
    } },
];

let pass = 0, fail = 0;
for (const result of [runCases(CASES), agreeAcrossFormats([
  // dotnet test's console output prints no columns and neither does the trx document.
  ["dotnet test", ["dotnettest_text_same_fail.txt", "dotnettest_trx_fail.txt"]],
  // What the run said does not change with the language it was said in - only the words
  // around it. The assertion messages are the test framework's and are not translated.
  ["dotnet test languages", ["dotnettest_locale_en_fail.txt", "dotnettest_locale_de_fail.txt",
    "dotnettest_locale_ja_fail.txt", "dotnettest_locale_fr_fail.txt", "dotnettest_locale_ru_fail.txt",
    "dotnettest_locale_pt_br_fail.txt"]],
  // The assertion's message is MSTest's, and MSTest translates it; the exception's is not.
  ["dotnet test platform languages", ["dotnettest_mtp_locale_en_fail.txt", "dotnettest_mtp_locale_de_fail.txt",
    "dotnettest_mtp_locale_ja_fail.txt", "dotnettest_mtp_locale_es_fail.txt", "dotnettest_mtp_locale_it_fail.txt",
    "dotnettest_mtp_locale_zh_hant_fail.txt"], ["message"]],
  ["dotnet test platform detailed", ["dotnettest_mtp_locale_de_fail.txt", "dotnettest_mtp_detailed_de_fail.txt"]],
])]) {
  pass += result.pass;
  fail += result.fail;
}


try {
  const raw = fx("dotnet_fail.txt");
  const withoutBanner = raw.slice(raw.indexOf("/home/dev/cs/app/Program.cs"));
  const full = analyse(raw), partial = analyse(withoutBanner);
  assert.equal(partial.tool, "dotnet");
  assert.deepEqual(partial.failures, full.failures);
  assert.equal(partial.summary, full.summary);
  // A single diagnostic needs neither a restore banner nor "Build FAILED".
  const single = analyse(withoutBanner.split("\n")[0]);
  assert.equal(single.tool, "dotnet");
  assert.deepEqual(single.failures, full.failures.slice(0, 1));
  assert.equal(analyse(fx("tsc_plain.txt")).tool, "tsc");
  console.log("  ok   .NET diagnostics need no restore banner and do not claim TypeScript");
  pass++;
} catch (e) { console.log(`  FAIL banner-free .NET detection\n       ${e.message}`); fail++; }

// A presentation mode is not a different failure. Terminal Logger is what `dotnet` uses
// by default on a terminal in .NET 10, so this is the ordinary way a restore fails now.
try {
  const plain = analyse(fx("dotnet_restore_plain_fail.txt"));
  const terminal = analyse(fx("dotnet_restore_terminal_fail.txt"));
  const facts = (r) => r.failures.map((f) => [f.file, f.line, f.col, f.code, f.severity, f.message]);
  assert.equal(terminal.tool, plain.tool);
  assert.equal(terminal.summary, plain.summary);
  assert.deepEqual(facts(terminal), facts(plain),
    "a restore failure reads differently under the Terminal Logger");
  const build = analyse(fx("dotnet_terminal_plain_fail.txt"));
  const buildTl = analyse(fx("dotnet_terminal_logger_fail.txt"));
  assert.deepEqual(facts(buildTl), facts(build),
    "a compile failure reads differently under the Terminal Logger");
  console.log("  ok   a Terminal Logger restore failure says what plain MSBuild says");
  pass++;
} catch (e) { console.log(`  FAIL Terminal Logger restore vs plain\n       ${e.message}`); fail++; }

// VSTest's default/minimal and detailed console modes print the same failures around
// different amounts of adapter chatter. The extra skipped-test message in detailed
// mode must not change either the diagnosis or the summary.
try {
  const compact = analyse(fx("dotnettest_vstest_fail.txt"));
  const detailed = analyse(fx("dotnettest_vstest_detailed_fail.txt"));
  const facts = (r) => r.failures.map((f) =>
    [f.file, f.line, f.title, f.subject, f.severity, f.message]);
  assert.equal(detailed.tool, compact.tool);
  assert.equal(detailed.summary, compact.summary);
  assert.deepEqual(facts(detailed), facts(compact),
    "VSTest verbosity changed the failures that were read");
  const retries = analyse(fx("dotnettest_vstest_fail.txt") + "\n" +
    fx("dotnettest_vstest_detailed_fail.txt"));
  assert.equal(retries.summary, undefined,
    "separate VSTest run tallies were presented as one run's headline");
  console.log("  ok   dotnet test verbosity changes no extracted facts");
  pass++;
} catch (e) { console.log(`  FAIL dotnet test verbosity\n       ${e.message}`); fail++; }

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
