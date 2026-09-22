// PHP: php and PHPUnit.
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
  { file: "phpunit_error_fail.txt", tool: "phpunit", n: 1, check: (r) => {
      // PHPUnit heads an escaped exception "There was 1 error", not "1 failure", and
      // reading only the failure wording meant this fell through to the guess.
      assert.equal(r.summary, "1 error");
      assert.equal(r.failures[0].title, "ErrTest::testBoom");
      assert.equal(r.failures[0].line, 4);
      assert.match(r.failures[0].message, /Call to a member function method\(\) on null/);
      assert.doesNotMatch(r.failures[0].message, /ERRORS!/, "the banner is not part of the message");
    } },
  { file: "phpunit_load_fail.txt", tool: "phpunit", n: 1, check: (r) => {
      assert.equal(r.summary, "error inside PHPUnit");
      assert.match(r.failures[0].file, /CrashTest\.php$/);
      assert.equal(r.failures[0].line, 2);
      assert.match(r.failures[0].message, /test file blew up at load/);
      assert.doesNotMatch(JSON.stringify(r.failures), /phar:\/\//, "PHPUnit's own frames are not the cause");
    } },
  // PHP writes the fatal twice, to the error log and to stdout, differing by a "PHP "
  // prefix and a space. Counting both says the run failed twice as badly - the two copies
  // produce identical failures, so the pipeline's own de-duplication collapses them.
  { file: "php_fatal_fail.txt", tool: "php", n: 1, check: (r) => {
      assert.equal(r.failures[0].file, "/home/dev/app/bad.php");
      assert.equal(r.failures[0].line, 2);
      assert.match(r.failures[0].message, /Call to a member function method\(\) on null/);
      // the class is the searchable handle, and it is not left in the message as well
      assert.equal(r.failures[0].code, "Error");
      assert.doesNotMatch(r.failures[0].message, /Fatal error|Uncaught/);
      // "#1 {main}" is the entry point and carries nothing
      assert.deepEqual(r.failures[0].trace, ["f() (/home/dev/app/bad.php:3)"]);
      // the warning PHP printed first is context, not the headline - and it arrives
      // doubled too, so counting lines said two
      assert.equal(r.summary, "1 error, 1 warning first");
    } },
  // Captured on PHP 8.5. A file that will not parse never runs, so there is no exception
  // and no stack - and the guess found no location at all for it.
  { file: "php_parse_fail.txt", tool: "php", n: 1, check: (r) => {
      assert.equal(r.failures[0].line, 2);
      assert.match(r.failures[0].file, /p2\.php$/);
      assert.match(r.failures[0].message, /^syntax error, unexpected token "\{"/);
      assert.equal(r.failures[0].label, "parse error");
      assert.equal(r.failures[0].code, undefined);
    } },
  { file: "php_require_fail.txt", tool: "php", n: 1, check: (r) => {
      // The include path is longer than the diagnosis and never varies, while the file
      // it could not find is the answer.
      assert.doesNotMatch(r.failures[0].message, /include_path/);
      assert.match(r.failures[0].message, /^Failed opening required 'nothing-here\.php'$/);
      assert.equal(r.failures[0].code, "Error");
    } },
  // One PHPUnit run - two failed assertions and one escaped exception, which PHPUnit
  // counts separately - in its console output, its --log-junit document and --testdox.
  // The same PHPUnit 11 run with --no-output --log-teamcity php://stdout: TeamCity's
  // service messages and nothing else, which read as nothing. An error and a failure are
  // both a test that failed there, so the summary says only that.
  { file: "phpunit_teamcity_fail.txt", tool: "phpunit", n: 3, check: (r) => {
      assert.deepEqual(r.failures.map((f) => [f.subject, f.file.split("/").pop(), f.line]), [
        ["ArithmeticTest::testAddition", "ArithmeticTest.php", 9], ["ArithmeticTest::testGreeting", "ArithmeticTest.php", 14],
        ["CrashTest::testUnexpectedCrash", "CrashTest.php", 9],
      ]);
      assert.equal(r.failures[2].message, "RuntimeException: fixture exploded");
      assert.equal(r.summary, "3 of 3 tests failed");
    } },
  // --teamcity prints the messages and the console's own report, and each result is one.
  { file: "phpunit_teamcity_text_fail.txt", tool: "phpunit", n: 3, check: (r) => {
      assert.equal(r.summary, "2 failures, 1 error");
    } },
  { file: "phpunit_text_same_fail.txt", tool: "phpunit", n: 3, check: (r) => {
      assert.equal(r.summary, "2 failures, 1 error");
      // The errors section is printed above the failures section with a rule between
      // them. Without stopping at the rule the error carried "--" and the next
      // section's heading along as part of its message.
      assert.equal(r.failures[0].message, "RuntimeException: fixture exploded");
      assert.equal(r.failures[0].line, 9);
    } },
  // JUnit is a shape every runner writes, so what makes a result PHPUnit's is inside
  // the element: PHPUnit opens the body by naming the test as `Class::method`, and a
  // result is read only when that name is the case's own.
  { file: "phpunit_junit_fail.txt", tool: "phpunit", n: 3, check: (r) => {
      // the document prints no tally, but it counts the same things on its root suite
      assert.equal(r.summary, "2 failures, 1 error");
      assert.deepEqual(r.failures.map((f) => f.subject), ["ArithmeticTest::testAddition",
        "ArithmeticTest::testGreeting", "CrashTest::testUnexpectedCrash"]);
      // the line the assertion failed on, which the body ends with - not the line the
      // method is declared on, which the element's own attribute gives
      assert.deepEqual(r.failures.map((f) => f.line), [9, 14, 9]);
      assert.equal(r.failures[0].message, "Failed asserting that 4 is identical to 5.");
      assert.doesNotMatch(JSON.stringify(r.failures), /ArithmeticTest::testAddition\\n/);
    } },
  // --testdox renames the class and the test into prose, which is the point of the
  // format, so those are the names reported. The location and the message are the ones
  // the console output gives.
  { file: "phpunit_testdox_fail.txt", tool: "phpunit", n: 3, check: (r) => {
      assert.equal(r.summary, "2 failures, 1 error");
      assert.deepEqual(r.failures.map((f) => f.subject),
        ["Arithmetic › Addition", "Arithmetic › Greeting", "Crash › Unexpected crash"]);
      assert.deepEqual(r.failures.map((f) => f.line), [9, 14, 9]);
      assert.equal(r.failures[0].message, "Failed asserting that 4 is identical to 5.");
      // the rule PHPUnit draws down the left of the body is not part of the message
      assert.doesNotMatch(JSON.stringify(r.failures), /│/);
    } },
  { file: "phpunit_fail.txt", tool: "phpunit", n: 2, check: (r) => {
      assert.equal(r.summary, "2 failures");
      assert.equal(r.failures[0].title, "ShopTest::testInvoiceTotal");
      assert.equal(r.failures[0].line, 8);
      assert.match(r.failures[0].message, /1049 is identical to 1050/);
      // the trailing "FAILURES! / Tests: 3, Assertions: 3" must not land in a message
      assert.ok(!r.failures.some((f) => /FAILURES!|Assertions:/.test(f.message)),
        "the run summary must not be absorbed into the last failure");
    } },
  // Captured with Composer 2.10.3 on PHP 8.5. `composer install` is to a PHP CI job what
  // `bundle install` is to a Ruby one, and none of the ways it fails was read. composer
  // says almost everything twice: a resolution failure is a headline, the numbered
  // problems, then "Potential causes:" with four guesses and a link to a manual. Only
  // the numbered problems say what happened.
  { file: "composer_missing_package_fail.txt", tool: "composer", n: 1, check: (r) => {
      assert.equal(r.failures[0].subject, "vendor/definitely-not-a-real-package-xyzzy",
        "the package that cannot be had is the answer");
      assert.match(r.failures[0].message, /it could not be found in any version/);
      // composer opens with two lines about the root version and the missing lock file.
      // Neither is the failure, and the first of them contains "could not".
      assert.doesNotMatch(JSON.stringify(r.failures),
        /could not detect the root package|No composer.lock file present|Loading composer repositories/);
      // ...and closes with four guesses and a link to the troubleshooting guide.
      assert.doesNotMatch(JSON.stringify(r.failures), /Potential causes|troubleshooting/);
    } },
  { file: "composer_platform_fail.txt", tool: "composer", n: 1, check: (r) => {
      // php is a package to composer like any other, and it is what was required - not
      // the version it went on to name as the one you have.
      assert.equal(r.failures[0].subject, "php");
      assert.match(r.failures[0].message, /requires php \^5\.3 but your php version/);
    } },
  { file: "composer_json_syntax_fail.txt", tool: "composer", n: 1, check: (r) => {
      // The box is headed "In JsonFile.php line 398:" - composer's own source, which is
      // nobody's business. The file to open is the one named inside the message.
      assert.equal(r.failures[0].file, "./composer.json");
      assert.equal(r.failures[0].line, 4);
      assert.equal(r.failures[0].label, "composer error");
      assert.match(r.failures[0].message, /extra trailing comma/);
      assert.doesNotMatch(JSON.stringify(r.failures), /JsonFile\.php/);
      // composer follows a boxed error with the command's own usage line, which is one
      // line long enough to bury the failure under it.
      assert.doesNotMatch(JSON.stringify(r.failures), /prefer-source|classmap-authoritative/);
    } },
];

let pass = 0, fail = 0;
for (const result of [runCases(CASES), agreeAcrossFormats([
  // --testdox renames every test on purpose, so the name is what differs there; it is
  // pinned in its own row above.
  ["phpunit", ["phpunit_text_same_fail.txt", "phpunit_junit_fail.txt"]],
  // TeamCity's message is the assertion alone; the console prints the diff under it.
  ["phpunit teamcity", ["phpunit_text_same_fail.txt", "phpunit_teamcity_fail.txt", "phpunit_teamcity_text_fail.txt"], ["message"]],
  ["phpunit testdox", ["phpunit_text_same_fail.txt", "phpunit_testdox_fail.txt"], ["subject"]],
])]) {
  pass += result.pass;
  fail += result.fail;
}


console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
