// The JVM: Maven, Gradle, javac and JUnit reports.
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
  { file: "maven_dependency_fail.txt", tool: "maven", n: 1, check: (r) => {
      // Maven reports everything that is not a compiler diagnostic as a failed goal.
      assert.equal(r.failures[0].label, "goal failed");
      assert.match(r.failures[0].message, /Could not resolve dependencies/);
      assert.match(r.failures[0].message, /does-not-exist-xyz/);
      assert.doesNotMatch(r.failures[0].message, /\[Help 1\]|Re-run Maven/,
        "how to get more output is not what went wrong");
    } },
  { file: "gradle_dependency_fail.txt", tool: "gradle", n: 1, check: (r) => {
      // Already handled by the build-script branch; here so it stays that way.
      assert.match(r.failures[0].message, /Could not resolve com\.example\.nope/);
    } },
  // Captured with javac 26.0.2.1 (-Xlint:unchecked), Gradle 9.7.1 (Java plugin
  // with the same flag), and mypy 2.3.1 (--no-error-summary, with/without columns).
  // javac translates its severity into the three languages it ships, and nothing else:
  // `Fehler:`, `エラー:`, `错误:`. The set is javac's own and it is closed, so it is named.
  { file: "javac_locale_en_fail.txt", tool: "jvm", n: 2, check: (r) => {
      assert.deepEqual(r.failures.map((f) => `${f.file}:${f.line}`), ["A.java:3", "A.java:4"]);
      for (const f of r.failures) assert.equal(f.label, "compile error");
    } },
  { file: "javac_locale_de_fail.txt", tool: "jvm", n: 2, check: (r) => {
      assert.deepEqual(r.failures.map((f) => `${f.file}:${f.line}`), ["A.java:3", "A.java:4"]);
      for (const f of r.failures) assert.equal(f.label, "compile error");
    } },
  { file: "javac_locale_ja_fail.txt", tool: "jvm", n: 2, check: (r) => {
      assert.deepEqual(r.failures.map((f) => `${f.file}:${f.line}`), ["A.java:3", "A.java:4"]);
      for (const f of r.failures) assert.equal(f.label, "compile error");
    } },
  { file: "javac_locale_zh_fail.txt", tool: "jvm", n: 2, check: (r) => {
      assert.deepEqual(r.failures.map((f) => `${f.file}:${f.line}`), ["A.java:3", "A.java:4"]);
      for (const f of r.failures) assert.equal(f.label, "compile error");
    } },
  { file: "javac_fail.txt", tool: "jvm", n: 1, check: (r) => {
      assert.equal(r.failures[0].file, "Main.java");
      assert.equal(r.failures[0].line, 5);
      assert.equal(r.failures[0].title, "compile error");
      assert.match(r.failures[0].message, /String cannot be converted to int/);
      assert.doesNotMatch(r.failures[0].message, /unchecked/);
    } },
  { file: "gradle_warnings_fail.txt", tool: "gradle", n: 1, check: (r) => {
      assert.equal(r.summary, "build failed");
      assert.equal(r.failures[0].line, 5);
      assert.match(r.failures[0].file, /Main\.java$/);
      assert.match(r.failures[0].message, /String cannot be converted to int/);
      assert.doesNotMatch(r.failures[0].message, /unchecked/);
      // severity used to be internal bookkeeping that jvm.js stripped before emitting.
      // It is now a declared field, so the guarantee changes from "absent" to "correct":
      // warnings must still never reach the failure list.
      assert.equal(r.failures[0].severity, "error", "a warning must not be reported as a failure");
    } },
  { file: "maven_fail.txt", tool: "maven", n: 2, check: (r) => {
      // maven prints every error twice; the second copy must be collapsed
      assert.equal(r.failures.length, 2);
      assert.match(r.failures[0].file, /Shop\.java$/);
      assert.equal(r.failures[0].line, 4);
      assert.equal(r.failures[0].col, 20);
      assert.match(r.failures[1].message, /cannot find symbol/);
    } },
  // One Gradle run of a test suite with two failing tests, printed four ways. Gradle names
  // each failed test and where it broke, and nothing read that: what came back was the
  // consequence - "Execution failed for task ':test'" - labelled a build script error,
  // with no test, no file and no line.
  { file: "gradle_tests_plain_fail.txt", tool: "gradle", n: 2, check: (r) => {
      assert.deepEqual(r.failures.map((f) => f.subject),
        ["InvoiceTest > roundsTaxToTheNearestCent()", "RefundTest > refundsANegativeInvoice()"]);
      assert.deepEqual(r.failures.map((f) => `${f.file}:${f.line}`), ["InvoiceTest.java:11", "RefundTest.java:8"]);
      // the short format says which exception and where, and nothing about why
      assert.equal(r.failures[0].message, "org.opentest4j.AssertionFailedError");
      for (const f of r.failures) assert.equal(f.category, "test");
      assert.equal(r.summary, "3 tests completed, 2 failed");
      assert.doesNotMatch(JSON.stringify(r.failures), /build script|Execution failed for task/);
    } },
  // exceptionFormat FULL gives the message and the stack. The first frames are JUnit's
  // assertion builder, behind Gradle's `app//` classloader prefix; the location is the
  // frame in the test's own class.
  { file: "gradle_tests_full_fail.txt", tool: "gradle", n: 2, check: (r) => {
      assert.deepEqual(r.failures.map((f) => `${f.file}:${f.line}`), ["InvoiceTest.java:11", "RefundTest.java:8"]);
      assert.equal(r.failures[0].message, "org.opentest4j.AssertionFailedError: expected: <1238> but was: <1237>");
      // it threw inside the code under test, and the location is still the test's own
      // frame - the same line Gradle's short format and Surefire's console both give
      assert.equal(r.failures[1].message, "java.lang.IllegalArgumentException: net amount is negative");
      assert.doesNotMatch(JSON.stringify(r.failures), /AssertionFailureBuilder/);
    } },
  // --console=rich colours FAILED, and it is the same block underneath.
  { file: "gradle_tests_rich_fail.txt", tool: "gradle", n: 2, check: (r) => {
      assert.deepEqual(r.failures.map((f) => `${f.file}:${f.line}`), ["InvoiceTest.java:11", "RefundTest.java:8"]);
    } },
  // -q prints no test names at all - only the tally and "There were failing tests". That
  // is a test failure whose tests are not in the log, not a build script that failed.
  { file: "gradle_tests_quiet_fail.txt", tool: "gradle", n: 1, check: (r) => {
      assert.equal(r.failures[0].label, "tests failed");
      assert.equal(r.failures[0].category, "test");
      assert.match(r.failures[0].message, /^3 tests completed, 2 failed\n/);
      assert.equal(r.summary, "3 tests completed, 2 failed");
    } },
  { file: "gradle_fail.txt", tool: "gradle", n: 2, check: (r) => {
      // real gradle javac output, printed once plainly and once indented under
      // "What went wrong" - both copies must collapse to two failures
      assert.equal(r.failures.length, 2);
      assert.match(r.failures[0].file, /Shop\.java$/);
      assert.equal(r.failures[0].line, 4);
      assert.match(r.failures[0].message, /incompatible types/);
      assert.equal(r.tool, "gradle", "gradle javac output must not be claimed by mypy");
    } },
  { file: "gradle_java_fail.txt", tool: "gradle", n: 2, check: (r) => {
      assert.equal(r.summary, "build failed");
      assert.equal(r.failures[0].file, "/workspace/src/main/java/com/acme/Invoice.java");
      assert.equal(r.failures[0].line, 18);
      assert.equal(r.failures[0].col, undefined);
      assert.match(r.failures[1].message, /cannot find symbol/);
    } },
  { file: "gradle_rich_console_fail.txt", tool: "gradle", n: 2, check: (r) => {
      // Real Gradle 9 rich-console output captured through a pipe. Its two-row progress
      // display interrupts the repeated second diagnostic in the middle of "Invoice".
      // Deleting only the escape codes glued the progress text to the filename and
      // invented a third compile error at a file that never existed.
      assert.match(fx("gradle_rich_console_fail.txt"), /\x1b\[2A/,
        "the captured cursor redraw that caused this regression disappeared");
      assert.equal(r.summary, "build failed");
      assert.deepEqual(r.failures.map((f) => [f.file, f.line]), [
        ["/home/dev/gradle-rich/src/main/java/dev/sample/Invoice.java", 5],
        ["/home/dev/gradle-rich/src/main/java/dev/sample/Invoice.java", 6],
      ]);
    } },
  // The same test suite under Maven, as its console printed it and as the two reports
  // Surefire leaves behind. The console was read; the reports were not, and the generic
  // reader's one location was a line inside JUnit's assertion builder.
  { file: "maven_tests_batch_same_fail.txt", tool: "maven", n: 2, check: (r) => {
      assert.deepEqual(r.failures.map((f) => `${f.file}:${f.line}`), ["CartTest.java:9", "ShippingTest.java:8"]);
    } },
  // JUnit's XML is a shape every runner writes. What makes a case a JVM test is inside
  // it: a Java stack frame naming the case's own class - which is also where the location
  // comes from.
  { file: "maven_surefire_xml_fail.txt", tool: "maven", n: 2, check: (r) => {
      assert.deepEqual(r.failures.map((f) => f.subject), ["CartTest.totalsAnInvoice", "ShippingTest.quotesShipping"]);
      assert.deepEqual(r.failures.map((f) => `${f.file}:${f.line}`), ["CartTest.java:9", "ShippingTest.java:8"]);
      assert.equal(r.failures[0].message, "org.opentest4j.AssertionFailedError: expected: <6> but was: <4>");
      // the CDATA markers and the stack are not the message
      assert.doesNotMatch(JSON.stringify(r.failures), /CDATA|AssertionFailureBuilder/);
      for (const f of r.failures) assert.equal(f.category, "test");
    } },
  { file: "maven_surefire_txt_fail.txt", tool: "maven", n: 2, check: (r) => {
      assert.deepEqual(r.failures.map((f) => f.subject), ["CartTest.totalsAnInvoice", "ShippingTest.quotesShipping"]);
      assert.deepEqual(r.failures.map((f) => `${f.file}:${f.line}`), ["CartTest.java:9", "ShippingTest.java:8"]);
      assert.equal(r.failures[1].message, "java.lang.IllegalStateException: fixture exploded");
    } },
  // Gradle writes the same XML without the CDATA, with `()` after the method, and with
  // nothing in it that says which build tool wrote it - so it is named for what it is.
  { file: "gradle_junit_xml_fail.txt", tool: "junit", n: 2, check: (r) => {
      assert.deepEqual(r.failures.map((f) => f.subject),
        ["InvoiceTest.roundsTaxToTheNearestCent", "RefundTest.refundsANegativeInvoice"]);
      assert.deepEqual(r.failures.map((f) => `${f.file}:${f.line}`), ["InvoiceTest.java:11", "RefundTest.java:8"]);
      assert.equal(r.failures[0].message, "org.opentest4j.AssertionFailedError: expected: <1238> but was: <1237>");
    } },
  { file: "maven_test_fail.txt", tool: "maven", n: 1, check: (r) => {
      // real `mvn test` on stleary/JSON-java after changing one exception message.
      // Surefire test failures used to fall through to a counter - "Tests run: 164,
      // Failures: 1" - which names no test, no line and no assertion.
      assert.equal(r.summary, "Tests run: 792, Failures: 1, Errors: 0, Skipped: 6",
        "the run total, not the first per-class line");
      const f = r.failures[0];
      assert.equal(f.title, "JSONObjectTest.jsonObjectNonAndWrongValues");
      assert.equal(f.file, "JSONObjectTest.java");
      assert.equal(f.line, 1055);
      assert.match(f.message, /expected:<.*not found.*> but was:<.*is absent.*>/);
      assert.ok(!/Tests run:/.test(f.message), "the counter is a summary, not a failure message");
    } },
  { file: "gradle_script_fail.txt", tool: "gradle", n: 1, check: (r) => {
      // real `gradle test` on stleary/JSON-java under Gradle 9, which removed the
      // sourceCompatibility property. The build script fails to evaluate - a very
      // common failure - and whyitbroke printed NOTHING at all: jvm.js detected the
      // output but extracted no failure, and the generic fallback does not match
      // "FAILURE:" (no word boundary after FAIL) or "with an exception." (no colon).
      const f = r.failures[0];
      assert.equal(f.title, "build script");
      assert.match(f.file, /build\.gradle$/);
      assert.equal(f.line, 55);
      assert.match(f.message, /A problem occurred evaluating root project/);
      // the "> " detail line carries the actual cause and must not be dropped
      assert.match(f.message, /Could not set unknown property 'sourceCompatibility'/);
      assert.ok(!/^>/m.test(f.message), "gradle's leading > is punctuation, not content");
    } },
];

let pass = 0, fail = 0;
for (const result of [runCases(CASES), agreeAcrossFormats([
  // javac's messages ARE translated, so the message is the one thing its languages do not
  // share; the file and the line always are.
  ["javac languages", ["javac_locale_en_fail.txt", "javac_locale_de_fail.txt",
    "javac_locale_ja_fail.txt", "javac_locale_zh_fail.txt"], ["message"]],
  ["gradle console", ["gradle_tests_plain_fail.txt", "gradle_tests_rich_fail.txt"]],
  // The short exception format names the exception and not its message.
  ["gradle exception format", ["gradle_tests_plain_fail.txt", "gradle_tests_full_fail.txt"], ["message"]],
  // Surefire's two reports of one run agree test for test.
  ["surefire reports", ["maven_surefire_xml_fail.txt", "maven_surefire_txt_fail.txt"]],
  // Gradle's XML and its full console format carry the same message and location; the
  // name is Gradle's own rendering in the console and the class and method in the XML.
  ["gradle report", ["gradle_tests_full_fail.txt", "gradle_junit_xml_fail.txt"], ["subject"]],
  // Maven's console abbreviates the exception - "IllegalState fixture exploded" - where
  // its reports keep the class whole.
  ["maven console", ["maven_tests_batch_same_fail.txt", "maven_surefire_xml_fail.txt"], ["message"]],
])]) {
  pass += result.pass;
  fail += result.fail;
}


// javac compiled both classes and warned four times, and exited 0. The generic reader
// already skipped a line that starts with `warning:`, but not the same word after a
// location - `Orders.java:8: warning: [rawtypes] found raw type: List` - and said
// "3 errors (no parser for this tool - best guess)" about a build that worked.
try {
  const r = analyse(fx("javac_warnings_only.txt"));
  assert.ok(!r?.failures?.length, `a clean compile was read as ${r?.summary ?? r?.failures?.length}`);
  // ...and the rule is about the word after the location, not about the location: the
  // same shape saying `error:` is still a diagnosis.
  const broke = analyse(fx("javac_warnings_only.txt").replace("Checkout.java:3: warning:", "Checkout.java:3: error:"));
  assert.ok(broke.failures.some((f) => f.file === "Checkout.java" && f.line === 3), "an error after a location went unread");
  assert.ok(!broke.failures.some((f) => /warning/.test(f.message)), "a warning came back as a failure beside the error");
  console.log("  ok   a warning after a location is not a failure");
  pass++;
} catch (e) { console.log(`  FAIL located warnings\n       ${e.message}`); fail++; }

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
