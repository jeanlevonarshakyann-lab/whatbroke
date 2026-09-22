// JavaScript runtimes and test runners: node and node --test, jest, vitest, mocha, ava, jasmine, TAP, playwright, bun, deno.
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
  // Captured with @playwright/test. Playwright heads a failure with the location of the
  // TEST and then gives the location of the THROW further down, and closes each block
  // with a path to an artifact to go and read.
  { file: "playwright_fail.txt", tool: "playwright", n: 2, check: (r) => {
      assert.equal(r.summary, "2 failed");
      assert.deepEqual(r.failures.map((f) => f.title), ["adds up", "throws"]);
      // the throw's line, not the test's declaration line
      assert.equal(r.failures[0].line, 3);
      assert.equal(r.failures[1].line, 7);
      assert.match(r.failures[0].stmt, /expect\(1049\)\.toBe\(1050\)/);
      assert.match(r.failures[1].message, /Cannot read properties of null/);
      // "Error Context: test-results/..." is a file to open, not a failure - the guess
      // counted both of them as errors and missed the second real one
      assert.doesNotMatch(JSON.stringify(r.failures), /Error Context|error-context\.md/);
      // and the run's tally is not part of the last failure's message
      assert.doesNotMatch(r.failures[1].message, /2 failed/);
    } },
  // Captured with vitest 5.0 in a directory whose name has a space. vitest repeats the
  // file in brackets when it fails to load, and asking whether that bracket looked like a
  // filename - no spaces, one extension - dropped the suite without a word: the log read
  // as the one test that ran. The bracket repeating the header is what vitest guarantees.
  { file: "vitest_suite_spaced_fail.txt", tool: "vitest", n: 2, check: (r) => {
      assert.equal(r.failures[0].file, "vitestdir/my tests/crash.test.js");
      assert.match(r.failures[0].message, /boom at import/);
      assert.equal(r.failures[1].title, "adds");
      // vitest's own tally counts tests, and a file that never loaded declared none.
      assert.equal(r.summary, "1 failed (1) — 1 file failed to load");
    } },
  // The same files under a workspace project: vitest badges each header "|unit|" and the
  // bracket still holds the bare file, so the header ends with it rather than equalling it.
  { file: "vitest_projects_fail.txt", tool: "vitest", n: 4, check: (r) => {
      assert.doesNotMatch(JSON.stringify(r.failures.map((f) => [f.file, f.title])), /\|unit\|/,
        "the project badge is not part of the file");
      assert.equal(r.failures.filter((f) => /crash\.test\.js$/.test(f.title)).length, 2);
      assert.equal(r.summary, "2 failed (2) — 2 files failed to load");
    } },
  { file: "vitest_suite_fail.txt", tool: "vitest", n: 1, check: (r) => {
      // A suite that throws before declaring a test cannot be named after one, so vitest
      // lists it under "Failed Suites" with the file in brackets rather than a test name
      // after a chevron - and only the chevron form was being read.
      assert.equal(r.failures[0].file, "t/crash.test.js");
      assert.equal(r.failures[0].line, 1);
      assert.match(r.failures[0].message, /vitest suite failed to collect/);
      // "Tests: no tests" over a real failure reads as though nothing was wrong
      assert.match(r.summary, /1 failed \(1\) \(no tests ran\)/);
    } },
  { file: "nodetest_crash_fail.txt", tool: "node --test", n: 1, check: (r) => {
      // TAP faithfully reports error: 'test failed', which says nothing. What happened
      // was printed above as TAP comments, and that is the only place it appears.
      assert.match(r.failures[0].message, /node:test suite crashed at import/);
      assert.doesNotMatch(r.failures[0].message, /^test failed$/);
      assert.equal(r.failures[0].file, "/home/dev/app/nt_crash.test.js");
    } },
  // Four runtimes crashing outside any test. None has a parser and none needs one -
  // they are here to hold the fallback to a standard, because a message with no
  // location is half an answer and the location is right there in the log.
  // Bun stamps its own version at the foot of a crash, which nothing else writes. Before
  // that was used, the node parser claimed this - the frames are node-shaped enough - and
  // a `bun` command was reported as having failed under node.
  { file: "bunrun_crash_fail.txt", tool: "bun", n: 1, check: (r) => {
      assert.equal(r.failures[0].file, "/home/dev/app/crash.ts");
      assert.equal(r.failures[0].line, 1);
      assert.equal(r.failures[0].col, 36);
      assert.match(r.failures[0].message, /bun runtime crash/);
      // the echoed source above the error is numbered; the line the failure is on
      assert.match(r.failures[0].stmt, /^function boom\(\): never/);
      assert.deepEqual(r.failures[0].trace, [
        "boom (/home/dev/app/crash.ts:1:36)", "<anonymous> (/home/dev/app/crash.ts:2:1)",
      ]);
      // "error:" is a constant bun prints for a class of failure, not a diagnostic code
      assert.equal(r.failures[0].label, "error");
      assert.equal(r.failures[0].code, undefined);
    } },
  { file: "bun_syntax_fail.txt", tool: "bun", n: 1, check: (r) => {
      assert.match(r.failures[0].message, /^Expected identifier but found end of file$/);
      assert.equal(r.failures[0].line, 1);
      assert.equal(r.failures[0].stmt, "const x = {");
    } },
  { file: "bun_import_fail.txt", tool: "bun", n: 1, check: (r) => {
      // An unresolved import names no line at all - the path is inside the message.
      assert.equal(r.failures[0].file, undefined);
      assert.match(r.failures[0].message, /Cannot find module '\.\/nothing-here'/);
    } },
  // deno writes the word in lower case and puts its frames on file:// URLs, where node
  // writes the class capitalised at column zero - so the two do not collide. This was a
  // guess: it found the file and the line but kept "error: " inside the message.
  { file: "denorun_crash_fail.txt", tool: "deno", n: 1, check: (r) => {
      // deno prints the source line and a caret between the message and the frames.
      assert.equal(r.failures[0].file, "/home/dev/app/dcrash.ts");
      assert.equal(r.failures[0].line, 1);
    } },
  // Captured on Deno 2.x.
  { file: "deno_syntax_fail.txt", tool: "deno", n: 1, check: (r) => {
      assert.equal(r.failures[0].code, "SyntaxError");
      assert.equal(r.failures[0].line, 1);
      assert.doesNotMatch(r.failures[0].message, /^error: /, "the word is not part of the message");
    } },
  { file: "deno_import_fail.txt", tool: "deno", n: 1, check: (r) => {
      // The module it could not resolve is named as a URL inside the message; the reader
      // wants the path, and the location is the line that asked for it.
      assert.equal(r.failures[0].line, 1);
      assert.doesNotMatch(r.failures[0].message, /file:\/\//, "the URL scheme is not part of the path");
      assert.match(r.failures[0].message, /Module not found ".*nothing-here\.ts"/);
    } },
  // Captured with oxlint 1. The whole finding is one line, with the fix suggestion
  // appended to the message rather than kept apart from it.
  // One real Playwright 1.63 run - two failed tests and one that passed - under its
  // reporters. The console ones were read; --reporter=json and --reporter=junit, the
  // documents a CI job keeps, came back with nothing. The github reporter was read with
  // its own annotation, and the next test's progress line, pasted into the message.
  ...["list_same", "dot", "github", "json", "junit"].map((form) => ({
    file: `playwright_${form}_fail.txt`, tool: "playwright", n: 2, check: (r) => {
      assert.deepEqual(r.failures.map((f) => [f.file.split("/").pop(), f.line, f.col, f.subject, f.stmt]), [
        ["cart.spec.ts", 4, 17, "totals an invoice", "expect(2 + 2).toBe(6);"],
        ["cart.spec.ts", 9, 9, "applies a discount", 'table.lookup("SPRING");'],
      ]);
      // The JSON report keeps the terminal's colours inside its strings.
      assert.equal(r.failures[0].message, "Error: expect(received).toBe(expected) // Object.is equality\nExpected: 6\nReceived: 4");
      assert.equal(r.failures[1].message, "TypeError: Cannot read properties of null (reading 'lookup')");
      assert.equal(r.summary, "2 failed");
    } })),
  // Captured with node-tap 21. TAP 14, which `node --test` also emits - they are told
  // apart by the YAML: tap writes an `at:` block, node writes `failureType`.
  { file: "tap_fail.txt", tool: "tap", n: 2, check: (r) => {
      assert.equal(r.failures[0].subject, "totals an invoice");
      assert.equal(r.failures[0].line, 2);
      assert.equal(r.failures[0].col, 3);
      // tap gives the values as a unified diff rather than as found/wanted fields
      assert.equal(r.failures[0].message, "-1050\n+1049");
      // and marks the failing line under `source:` with a --^ pointer
      assert.match(r.failures[0].stmt, /^t\.equal\(1049, 1050/);
      // the file-level line is a count of failures, not one of them
      assert.doesNotMatch(JSON.stringify(r.failures), /time=/);
    } },
  // Captured with jasmine 5. Another runner that produced no diagnosis at all.
  { file: "jasmine_fail.txt", tool: "jasmine", n: 2, check: (r) => {
      assert.equal(r.summary, "2 of 2 specs failed");
      assert.equal(r.failures[0].subject, "invoice finds an expiry claim");
      assert.equal(r.failures[0].message, "Expected undefined to be defined.");
      assert.match(r.failures[0].file, /sum\.spec\.js$/);
      assert.equal(r.failures[0].line, 3);
      // jasmine's own frames read "at <Jasmine>" and name no file, so the frame that
      // survives is always one of yours
      assert.doesNotMatch(JSON.stringify(r.failures), /<Jasmine>/);
    } },
  // Captured with ava 6. Like mocha, a failing run produced no diagnosis at all.
  { file: "ava_fail.txt", tool: "ava", n: 2, check: (r) => {
      assert.equal(r.summary, "2 tests failed");
      assert.equal(r.failures[0].subject, "totals an invoice");
      assert.equal(r.failures[0].line, 3);
      // a comparison reports the diff, not the test name back at you
      assert.equal(r.failures[0].message, "- 1049\n+ 1050");
      // an assertion that is NOT a comparison says so in prose, with the value under it
      // - and ava puts a blank line between the two
      assert.equal(r.failures[1].message, "Value is not truthy\nundefined");
      assert.equal(r.failures[1].line, 4);
      // the echoed source around the failing line is context, never the diagnosis
      assert.doesNotMatch(JSON.stringify(r.failures), /reduce\(/);
    } },
  { file: "ava_throw_fail.txt", tool: "ava", n: 1, check: (r) => {
      // a throw is located from its stack; ava's own pointer is not written for one
      assert.match(r.failures[0].file, /throw\.test\.js$/);
      assert.equal(r.failures[0].line, 2);
      assert.equal(r.failures[0].message, "payment gateway unreachable");
      // the site that failed is the test, so that is the subject - the thrown class
      // names the failure in the title rather than competing to be its identity
      assert.equal(r.failures[0].subject, "charges a card");
      assert.equal(r.failures[0].code, undefined);
      assert.match(r.failures[0].title, /\(Error\)/);
      // ava's own lib frames are under every throw and are never the answer
      assert.doesNotMatch(JSON.stringify(r.failures), /node_modules/);
    } },
  { file: "ava_load_fail.txt", tool: "ava", n: 1, check: (r) => {
      // a file that will not load never reaches the roll-call
      assert.match(r.failures[0].file, /syn\.test\.js$/);
      assert.equal(r.failures[0].code, "SyntaxError");
      assert.equal(r.failures[0].message, "Unexpected end of input");
    } },
  // Captured with mocha 11. A failing run produced no diagnosis at all before this -
  // not a worse answer, nothing - and mocha is among the most widely used JS runners.
  { file: "mocha_fail.txt", tool: "mocha", n: 2, check: (r) => {
      assert.equal(r.summary, "2 failing, 1 passing");
      assert.equal(r.failures[0].file, "test/sum.test.js");
      assert.equal(r.failures[0].line, 6);
      // the suite and the test are on separate lines; the reader wants both
      assert.equal(r.failures[0].subject, "invoice totals an invoice");
      assert.match(r.failures[0].message, /Expected values to be strictly equal/);
      assert.match(r.failures[1].message, /token should carry exp/);
      // node's own frames are under every one of these and are never the answer
      assert.doesNotMatch(JSON.stringify(r.failures), /node:internal/);
    } },
  // One real mocha 12 run - two failing tests and one passing - under its reporters.
  // spec, dot, list, min, progress, landing, nyan, tap, json and xunit were all read;
  // json-stream, the one a runner consumes as the run happens, read as nothing. (doc
  // writes an HTML page with no line numbers, and markdown lists only the passing tests.)
  ...["spec_same", "dot", "json_same", "json_stream"].map((form) => ({ file: `mocha_${form}_fail.txt`, tool: "mocha", n: 2, check: (r) => {
      assert.deepEqual(r.failures.map((f) => [f.file, f.line, f.col, f.subject]), [
        ["test/cart.test.js", 5, 12, "cart totals an invoice"], ["test/cart.test.js", 10, 11, "cart applies a discount"],
      ]);
      assert.ok(r.failures[0].message.startsWith("Expected values to be strictly equal:\n4 !== 6"), r.failures[0].message);
      // The legend over the diff says which sign is which, not what failed; it had taken
      // the place of the diff.
      assert.doesNotMatch(r.failures[0].message, /expected - actual/);
      assert.equal(r.summary, "2 failing, 1 passing");
    } })),
  { file: "mocha_hook_fail.txt", tool: "mocha", n: 1, check: (r) => {
      // a hook that throws is named for the hook, and the message is the throw - not
      // the hook's name repeated back
      assert.match(r.failures[0].subject, /before all/);
      assert.equal(r.failures[0].message, "payment gateway unreachable");
      assert.equal(r.failures[0].line, 2);
    } },
  { file: "mocha_timeout_fail.txt", tool: "mocha", n: 1, check: (r) => {
      // a timeout unwinds entirely inside node's timers, so there is no frame of yours
      // to point at. Reporting node:internal/timers as the place your test failed is
      // worse than reporting no place at all.
      assert.equal(r.failures[0].file, undefined);
      assert.match(r.failures[0].message, /^Timeout of 50ms exceeded/);
      // mocha repeats the test file in that message; the location already said it
      assert.doesNotMatch(r.failures[0].message, /\(\//);
    } },
  { file: "mocha_load_fail.txt", tool: "mocha", n: 1, check: (r) => {
      // a file that will not load never reaches the tally, so there is no numbered
      // block - just mocha's own line over a Node stack
      assert.equal(r.failures[0].file, "/home/dev/app/test/syn.test.js");
      assert.equal(r.failures[0].line, 2);
      assert.equal(r.failures[0].code, "SyntaxError");
      assert.equal(r.failures[0].message, "Unexpected end of input");
    } },
  { file: "node_syntax_fail.txt", tool: "node", n: 1, check: (r) => {
      // A syntax error's stack is entirely node's own machinery; the only place the
      // real location appears is the header above the caret.
      assert.equal(r.failures[0].file, "/home/dev/m3/syn.mjs");
      assert.equal(r.failures[0].line, 1);
      assert.doesNotMatch(String(r.failures[0].file), /^file:\/\//, "a URL is not a path");
      assert.doesNotMatch(String(r.failures[0].file), /node:internal/);
    } },
  { file: "node_import_fail.txt", tool: "node", n: 1, check: (r) => {
      // Here even the header is node's own file. No location at all beats a location
      // inside the runtime, which reads as though the bug were in node.
      assert.equal(r.failures[0].file, undefined);
      assert.match(r.failures[0].message, /Cannot find module/);
      assert.doesNotMatch(JSON.stringify(r.failures), /node:internal\/modules/);
    } },
  { file: "jest_suite_fail.txt", tool: "jest", n: 1, check: (r) => {
      // jest's tally reads "Tests: 0 total" when the suite never ran, and a headline of
      // "0 total" over a real failure reads as though nothing happened.
      assert.match(r.summary, /1 failed, 1 total \(no tests ran\)/);
      assert.doesNotMatch(r.summary, /^0 total$/);
      assert.equal(r.failures[0].file, "crash.test.js");
      assert.match(r.failures[0].message, /suite blew up before any test ran/);
    } },
  { file: "nodetest_nested_fail.txt", tool: "node --test", n: 3, check: (r) => {
      assert.equal(r.summary, "3 failed, 1 passed");
      assert.deepEqual(r.failures.map((f) => f.title), ["addition", "multiplication", "subtraction"]);
      assert.deepEqual(r.failures.map((f) => f.line), [5, 6, 8]);
      assert.ok(r.failures.every((f) => f.file.endsWith("/test/nested.test.cjs")));
      assert.match(r.failures[0].message, /2 !== 3/);
      assert.match(r.failures[1].message, /4 !== 5/);
      assert.match(r.failures[2].message, /6 !== 7/);
    } },
  { file: "node_stack.txt", tool: "node", n: 1, check: (r) => {
      const f = r.failures[0];
      assert.equal(f.title, "TypeError");
      assert.match(f.message, /Cannot read properties of null/);
      assert.equal(f.line, 1);
      assert.ok(f.hiddenFrames >= 5, "node internals should be hidden");
      assert.ok(f.trace.every((t) => !/node:internal/.test(t)));
    } },
  { file: "node_eval.txt", tool: "node", n: 1, check: (r) => {
      const f = r.failures[0];
      assert.equal(f.title, "TypeError");
      assert.equal(f.file, "[eval]");
      assert.equal(f.stmt, "null.x");
      // node's own eval wrapper must never be shown as user code
      assert.ok(!f.trace.some((t) => /\[eval\]-wrapper|node:internal/.test(t)),
        `wrapper frame leaked: ${JSON.stringify(f.trace)}`);
      assert.equal(f.hiddenFrames, 7);
    } },
  // One vitest run of two test files, in the default reporter, --reporter=junit and
  // --reporter=github-actions. The document came back with no diagnosis at all, and the
  // annotations fell through to the generic reader, which printed vitest's %0A-encoded
  // diff back as one long line.
  { file: "vitest_reporters_text_same_fail.txt", tool: "vitest", n: 2, check: (r) => {
      assert.deepEqual(r.failures.map((f) => f.subject),
        ["cart > totals an invoice", "quotes shipping"]);
      assert.deepEqual(r.failures.map((f) => f.line), [5, 4]);
    } },
  // JUnit is a shape every runner writes, so the bound is the suite vitest names itself.
  // Vitest writes Jest's document deliberately, and leaves `message` empty - the failure
  // text is in each assertion's failureMessages instead. The reconstruction found
  // nothing to reconstruct and the run came back with no diagnosis. The two documents
  // say which they are: Jest's carries `wasInterrupted`, vitest's carries `benchmarks`
  // on every assertion.
  // A reporter that writes to a file says so and prints nothing else. The run failed,
  // the answer exists, and a log holding only this line came back "could not identify a
  // diagnostic" - when vitest had just said where to look.
  { file: "vitest_report_file_fail.txt", tool: "vitest", n: 1, check: (r) => {
      assert.equal(r.failures[0].label, "report");
      assert.match(r.failures[0].message, /\/home\/dev\/shop\/\.vitest\/json\/output\.json/);
      // a headline has to admit the run failed, and "wrote a report" does not
      assert.match(r.summary, /the run failed and its JSON report is not in this log/);
      // it is a note about where the answer is, not a location in your code
      assert.equal(r.failures[0].file, undefined);
    } },
  { file: "vitest_json_fail.txt", tool: "vitest", n: 2, check: (r) => {
      assert.deepEqual(r.failures.map((f) => f.subject),
        ["cart > totals an invoice", "quotes shipping"]);
      assert.equal(r.failures[0].file, "/home/dev/shop/test/cart.test.js");
      assert.equal(r.failures[0].line, 5);
      assert.equal(r.failures[0].col, 75);
      // `fullName` joins the names with a space, which is neither reporter's separator
      assert.doesNotMatch(JSON.stringify(r.failures), /cart totals an invoice/);
      // the frames inside vitest's own dist are not where your test failed
      assert.doesNotMatch(JSON.stringify(r.failures), /node_modules/);
    } },
  { file: "vitest_junit_fail.txt", tool: "vitest", n: 2, check: (r) => {
      assert.deepEqual(r.failures.map((f) => f.subject),
        ["cart > totals an invoice", "quotes shipping"]);
      // the pointer frame in the body, not the file the suite is named after
      assert.equal(r.failures[0].file, "test/cart.test.js");
      assert.equal(r.failures[0].line, 5);
      assert.equal(r.failures[0].col, 75);
      // the value diff is part of the answer and the pretty reporter keeps it, so this
      // keeps it too - without the "- Expected / + Received" headers, which promise a
      // diff and show none
      assert.equal(r.failures[0].message,
        "AssertionError: expected 5 to be 6 // Object.is equality\n- 6\n+ 5");
      assert.doesNotMatch(JSON.stringify(r.failures), /[-+] (?:Expected|Received)/);
      // the entities are decoded
      assert.doesNotMatch(JSON.stringify(r.failures), /&(?:quot|apos|gt|lt|amp);/);
    } },
  // The annotation opens its title with the test file, which is the file it already
  // points at - a title whose first segment is not that file is another tool's.
  { file: "vitest_github_fail.txt", tool: "vitest", n: 2, check: (r) => {
      assert.deepEqual(r.failures.map((f) => f.subject),
        ["cart > totals an invoice", "quotes shipping"]);
      assert.equal(r.failures[1].line, 4);
      assert.equal(r.failures[1].col, 35);
      // the encoded newlines are decoded, not printed back
      assert.doesNotMatch(JSON.stringify(r.failures), /%0A/);
      // and the file is not repeated inside the test's name
      assert.doesNotMatch(JSON.stringify(r.failures.map((f) => f.subject)), /test\//);
    } },
  // Captured with vitest 5.0. A frame inside a named function is written with the
  // function in front of the file - `❯ lookup cart.js:2:40` - and everything before the
  // position was read as the file, so a helper that threw was reported in a file called
  // "lookup cart.js".
  { file: "vitest_named_frame_fail.txt", tool: "vitest", n: 2, check: (r) => {
      assert.equal(r.summary, "2 failed | 1 passed (3)");
      assert.equal(r.failures[0].file, "cart.test.js");
      assert.deepEqual([r.failures[1].file, r.failures[1].line, r.failures[1].col], ["cart.js", 2, 40]);
      assert.match(r.failures[1].message, /TypeError: Cannot read properties of undefined/);
    } },
  // ...and a file that would not load unwinds through vitest's own bundler first. Those
  // frames are not yours: the failure is in the file vitest named, at no line.
  { file: "vitest_load_frames_fail.txt", tool: "vitest", n: 1, check: (r) => {
      assert.equal(r.failures[0].file, "syn.test.js");
      assert.equal(r.failures[0].line, undefined);
      assert.doesNotMatch(String(r.failures[0].file), /node_modules|error /);
      assert.match(r.failures[0].message, /Parse failure/);
    } },
  { file: "vitest_fail.txt", tool: "vitest", n: 3, check: (r) => {
      assert.match(r.summary, /3 failed \| 1 passed/);
      const f = r.failures[0];
      assert.equal(f.title, "invoice total");
      assert.equal(f.line, 3);
      assert.equal(f.col, 62);
      assert.match(f.message, /expected 1049 to be 1050/);
      assert.match(f.message, /1050/);          // keeps the expected/received diff
      assert.equal(r.failures[2].title, "throws");
      assert.match(r.failures[2].message, /TypeError/);
    } },
  // One jest run over two test files, in the default reporter and in the GitHub one.
  // The GitHub reporter prints no tally at all, and repeats each failure inside a
  // ::group:: - so the count comes from what was annotated, and a failure that appears
  // in both the annotation and the group is read once.
  { file: "jest_gh_text_same_fail.txt", tool: "jest", n: 2, check: (r) => {
      assert.deepEqual(r.failures.map((f) => f.subject),
        ["quotes shipping", "cart › totals an invoice"]);
      assert.equal(r.failures[0].file, "test/ship.test.js");
      assert.equal(r.summary, "2 failed, 1 passed, 3 total");
    } },
  { file: "jest_github_fail.txt", tool: "jest", n: 2, check: (r) => {
      assert.deepEqual(r.failures.map((f) => f.subject),
        ["quotes shipping", "cart › totals an invoice"]);
      // the frame inside the annotation points at the assertion, not at the line the
      // test opens on, which is all the annotation's own file= and line= can say
      assert.equal(r.failures[0].file, "test/ship.test.js");
      assert.equal(r.failures[0].line, 2);
      assert.equal(r.failures[0].col, 35);
      assert.equal(r.failures[1].line, 5);
      // the reporter has no tally of its own, and "2 tests" is not "0 total"
      assert.equal(r.summary, "2 tests failed");
      // the encoded newlines are decoded, not left as %0A
      assert.doesNotMatch(JSON.stringify(r.failures), /%0A/);
    } },
  { file: "jest_fail.txt", tool: "jest", n: 2, check: (r) => {
      assert.match(r.summary, /2 failed, 1 passed/);
      const f = r.failures[0];
      assert.equal(f.title, "invoice total");
      assert.equal(f.file, "sum.test.js");
      assert.equal(f.line, 2);
      assert.match(f.message, /toBe\(expected\)/);
      assert.match(f.message, /Expected: 1050/);
      assert.match(f.message, /Received: 1049/);
      assert.equal(r.failures[1].title, "expired token");
    } },
  // Captured from three real Jest failures with `--json`. Jest writes its normal
  // report to stderr and this document to stdout, so keeping only stdout used to turn
  // three named failures into one generic guess over the JSON plumbing.
  { file: "jest_json_assertions_fail.txt", tool: "jest", n: 3, check: (r) => {
      assert.equal(r.summary, "3 failed, 1 passed, 4 total");
      assert.deepEqual(r.failures.map((f) => f.title), ["adds", "objects", "throws"]);
      assert.deepEqual(r.failures.map((f) => f.line), [1, 2, 3]);
      assert.match(r.failures[0].message, /Expected: 3/);
      assert.match(r.failures[1].message, /deep equality/);
      assert.match(r.failures[2].message, /undefinedFn is not defined/);
    } },
  // One run with every non-failing status makes the tally order and wording
  // observable, and was captured both as text and JSON for the parity gate below.
  { file: "jest_json_statuses_fail.txt", tool: "jest", n: 1, check: (r) => {
      assert.equal(r.summary, "1 failed, 1 skipped, 1 todo, 1 passed, 4 total");
      assert.equal(r.failures[0].file, "t.test.js");
      assert.equal(r.failures[0].line, 1);
      assert.equal(r.failures[0].col, 33);
    } },
  { file: "jest_text_statuses_fail.txt", tool: "jest", n: 1, check: (r) => {
      assert.equal(r.failures[0].title, "fails");
    } },
  // A suite-load error has no test and no user stack frame. The machine report's
  // absolute test-result name is the only location it provides.
  { file: "jest_json_suite_fail.txt", tool: "jest", n: 1, check: (r) => {
      assert.equal(r.summary, "1 failed, 1 total (no tests ran)");
      assert.equal(r.failures[0].file, "/home/dev/app/t.test.js");
      assert.equal(r.failures[0].title, "Test suite failed to run");
      assert.match(r.failures[0].message, /Jest encountered an unexpected token/);
    } },
  { file: "jest_text_suite_same_fail.txt", tool: "jest", n: 1, check: (r) => {
      assert.equal(r.failures[0].title, "Test suite failed to run");
    } },
  { file: "vitest_cluster_fail.txt", tool: "vitest", n: 3, check: (r) => {
      // real vitest run of pillarjs/path-to-regexp after making a trailing-delimiter
      // group mandatory. vitest labels its diff "- Expected:" / "+ Received:" WITH a
      // colon; those headers must never survive as message content, because without
      // their values they promise a diff and show none.
      assert.equal(r.summary, "191 failed | 293 passed (484)");
      for (const f of r.failures) {
        assert.ok(!/^[-+]\s*(Expected|Received):?\s*$/m.test(f.message ?? ""),
          `a bare diff header leaked into a message: ${JSON.stringify(f.message)}`);
      }
      assert.match(r.failures[0].message, /expected false to deeply equal/);
      assert.equal(r.failures[0].file, "src/index.spec.ts");
    } },
  { file: "jest_snapshot_fail.txt", tool: "jest", n: 1, check: (r) => {
      // real jest run of testing-library/jest-dom after inverting one matcher.
      assert.equal(r.summary, "94 failed, 538 passed, 632 total");
      const f = r.failures[0];
      // "FAIL jsdom src/a.js" - with multiple jest projects the display name comes
      // first, and taking the first token made every file the project name
      assert.equal(f.file, "src/__tests__/to-contain-html.js");
      assert.equal(f.line, 104);
      // jest uses the same bullet for config complaints as for failed tests
      assert.ok(!/Validation Warning|watchPlugins/.test(f.title + f.message),
        "a config warning must not be reported as a failed test");
      // a snapshot diff opens with count headers and a hunk header, and restates
      // the test name; none of those are the diff
      assert.ok(!/^[-+]\s*(Snapshot|Received)\s+[-+]\s*\d+$/m.test(f.message), "count header kept");
      assert.ok(!/^@@ /m.test(f.message), "hunk header kept");
      assert.ok(!/^Snapshot name:/m.test(f.message), "the title was restated in the message");
      assert.match(f.message, /toContainHTML/);

      // The file usually comes from the stack frame; the "FAIL <project> <path>"
      // header is the fallback when there is no frame. Strip the frames from this
      // same real output to exercise it - otherwise the fallback is never tested,
      // and with several jest projects it yielded the project name as the filename.
      const frameless = fx("jest_snapshot_fail.txt").split("\n").filter((l) => !/^\s+at /.test(l)).join("\n");
      const g = analyse(frameless).failures[0];
      assert.equal(g.file, "src/__tests__/to-contain-html.js",
        "with no stack frame the FAIL header must yield the path, not the project name");
    } },
  { file: "nodetest_fail.txt", tool: "node --test", n: 2, check: (r) => {
      // real `node --test` (TAP) run of sindresorhus/p-queue with the default
      // concurrency changed. This output was not supported at all - it fell through
      // to the generic guess and printed "error: |-", a YAML block marker.
      assert.equal(r.summary, "11 failed, 195 passed");
      const f = r.failures[0];
      assert.equal(f.title, "isRateLimited property");
      assert.match(f.file, /advanced\.ts$/);
      // `error: |-` is a YAML block scalar; its content is the deeper-indented lines
      assert.match(f.message, /^AssertionError: Expected values to be strictly equal:/);
      assert.match(f.message, /false !== true/);
      assert.ok(!/\|-|duration_ms|failureType|code:/.test(f.message),
        "YAML plumbing must not survive into the message");
      assert.equal(r.failures[1].title, "rate-limit events fire only once per transition");
    } },
  { file: "nodetest_reporter_tap_fail.txt", tool: "node --test", n: 1, check: (r) => {
      assert.equal(r.summary, "1 failed, 1 passed");
      assert.equal(r.failures[0].title, "fails");
      assert.equal(r.failures[0].file, "/home/dev/reporter.test.js");
      assert.equal(r.failures[0].line, 6);
      assert.equal(r.failures[0].col, 1);
    } },
  { file: "nodetest_reporter_spec_fail.txt", tool: "node --test", n: 1, check: (r) => {
      assert.equal(r.summary, "1 failed, 1 passed");
      assert.equal(r.failures[0].title, "fails");
      assert.equal(r.failures[0].file, "reporter.test.js");
      assert.equal(r.failures[0].line, 6);
      assert.equal(r.failures[0].col, 1);
    } },
  { file: "nodetest_reporter_junit_fail.txt", tool: "node --test", n: 1, check: (r) => {
      assert.equal(r.summary, "1 failed, 1 passed");
      assert.equal(r.failures[0].title, "fails");
      assert.equal(r.failures[0].file, "/home/dev/reporter.test.js");
      assert.equal(r.failures[0].line, 7);
      assert.equal(r.failures[0].col, 10);
      assert.doesNotMatch(JSON.stringify(r.failures), /<failure|&lt;|ERR_TEST_FAILURE/);
    } },
  { file: "nodetest_reporter_junit_no_skip_fail.txt", tool: "node --test", n: 1, check: (r) => {
      assert.equal(r.summary, "1 failed, 1 passed");
      assert.equal(r.failures[0].title, "fails second");
      assert.equal(r.failures[0].file, "/home/dev/no_skip.test.js");
      assert.equal(r.failures[0].line, 6);
      assert.equal(r.failures[0].col, 10);
      assert.match(r.failures[0].message, /actual - expected/);
    } },
  { file: "nodetest_reporter_dot_fail.txt", tool: "node --test", n: 1, check: (r) => {
      assert.equal(r.summary, "1 failed");
      assert.equal(r.failures[0].title, "fails");
      assert.equal(r.failures[0].file, "/home/dev/reporter.test.js");
      assert.equal(r.failures[0].line, 7);
      assert.equal(r.failures[0].col, 10);
    } },
  { file: "nodetest_reporter_spec_crash_fail.txt", tool: "node --test", n: 1, check: (r) => {
      assert.equal(r.summary, "1 failed");
      assert.equal(r.failures[0].file, "/home/dev/crash.test.js");
      assert.equal(r.failures[0].line, 1);
      assert.equal(r.failures[0].col, 7);
      assert.equal(r.failures[0].stmt, "throw new Error(\"module exploded before tests\");");
      assert.match(r.failures[0].message, /Error: module exploded before tests/);
      assert.equal(r.others, undefined, "the runtime preamble is not a second failure");
    } },
  { file: "nodetest_reporter_spec_syntax_fail.txt", tool: "node --test", n: 1, check: (r) => {
      assert.equal(r.failures[0].file, "/home/dev/syntax.test.js");
      assert.equal(r.failures[0].line, 1);
      assert.equal(r.failures[0].stmt, "const broken = ;");
      assert.match(r.failures[0].message, /SyntaxError: Unexpected token/);
      assert.equal(r.others, undefined, "the syntax preamble is not a second failure");
    } },
  { file: "nodetest_reporter_junit_crash_fail.txt", tool: "node --test", n: 1, check: (r) => {
      assert.equal(r.summary, "1 failed");
      assert.equal(r.failures[0].file, "crash.test.js");
      assert.equal(r.failures[0].title, "crash.test.js");
      assert.equal(r.failures[0].message, "test failed");
    } },
  { file: "nodetest_reporter_dot_crash_fail.txt", tool: "node --test", n: 1, check: (r) => {
      assert.equal(r.summary, "1 failed");
      assert.equal(r.failures[0].file, "crash.test.js");
      assert.equal(r.failures[0].title, "crash.test.js");
      assert.equal(r.failures[0].message, "test failed");
    } },
  // Captured with bun 1.3. A thrown Error is printed as "error: boom"; a thrown builtin
  // is printed with its class - "TypeError: null is not an object". Only the first was
  // read, so the other two came back as "its output is not in this log" - with their
  // output right there - and node's parser read the same lines as two crashes of its own.
  { file: "bun_throw_fail.txt", tool: "bun test", n: 3, check: (r) => {
      assert.equal(r.summary, "3 fail");
      assert.deepEqual(r.failures.map((f) => f.message), ["boom",
        "TypeError: null is not an object (evaluating 'null.charge')",
        "RangeError: Array length must be a positive integer of safe magnitude."]);
      assert.deepEqual(r.failures.map((f) => f.line), [2, 3, 4]);
      assert.equal(r.others, undefined, "node read the thrown errors as crashes of its own");
    } },
  { file: "bun_fail.txt", tool: "bun test", n: 2, check: (r) => {
      // real `bun test` run of pillarjs/path-to-regexp. bun writes "error:" at the
      // start of a line, which is exactly what the cargo parser looks for, so bun
      // output was claimed by cargo and came back as two locationless errors.
      assert.equal(r.summary, "192 fail, 191 pass");
      assert.deepEqual(r.failures.map((f) => f.title),
        ["path-to-regexp > pathToRegexp errors > should contain the error line",
          "path-to-regexp > match / with $options > should match /"]);
      assert.ok(!/\[[\d.]+ms\]/.test(r.failures[0].title), "the timing is not part of the test name");
      // 192 failures, and this capture holds two of their names: it begins mid-run, so
      // the first one's block was cut off above it. Saying so is the whole of what the
      // log supports - the block below that line is the SECOND failure's.
      assert.equal(r.failures[0].file, undefined);
      assert.match(r.failures[0].message, /not in this log/);
      const f = r.failures[1];
      assert.match(f.file, /index\.spec\.ts$/);
      assert.equal(f.line, 274);
      assert.match(f.message, /expect\(received\)\.toEqual\(expected\)/);
      // bun echoes the source and a caret, and labels its diff with tallies
      assert.ok(!/^\s*\d+\s*\|/m.test(f.message), "echoed source is not the message");
      assert.ok(!/^[-+]\s*(Expected|Received)\s+[-+]\s*\d+$/m.test(f.message), "diff tallies kept");
    } },
  // ...and a run whose two failures differ, which is what shows the pairing. bun prints
  // the block and THEN says whose it was, so reading forward from the "(fail)" line gave
  // every failure the next one's message and the last one the run's tally - "0 pass"
  // reported as a test's assertion. The only fixture above could not show it: 192
  // parameterised cases whose blocks differ by one character.
  // bun's JUnit report records WHICH tests failed and nothing else: every outcome is a
  // bare <failure type="AssertionError" /> with no message and no body. Nothing read it,
  // so a job keeping only the XML got no diagnosis - with the names, the file and the
  // line each test is declared on all sitting in it. The line is the declaration's, not
  // the assertion's; the document has no other.
  { file: "bun_junit_fail.txt", tool: "bun test", n: 2, check: (r) => {
      assert.deepEqual(r.failures.map((f) => f.subject),
        ["cart > totals an invoice", "raises unexpectedly"]);
      assert.equal(r.failures[0].file, "bt/cart.test.ts");
      assert.deepEqual(r.failures.map((f) => f.line), [4, 9]);
      for (const f of r.failures) assert.match(f.message, /not in this log/);
      // the document prints no tally line, but it counts the same things
      assert.equal(r.summary, "2 fail");
    } },
  // The same bun run with FORCE_COLOR set. bun draws a cross where it writes "(fail)"
  // without colour, and reading only the word found no failure at all: the generic
  // reader took over, kept "error:" in each message, and named no test.
  { file: "bun_color_fail.txt", tool: "bun test", n: 2, check: (r) => {
      assert.deepEqual(r.failures.map((f) => f.subject), ["cart > totals an invoice", "raises unexpectedly"]);
      assert.deepEqual(r.failures.map((f) => f.line), [5, 10]);
      assert.equal(r.failures[1].message, "fixture exploded");
    } },
  { file: "bun_color_plain_same_fail.txt", tool: "bun test", n: 2, check: (r) => {
      assert.deepEqual(r.failures.map((f) => f.subject), ["cart > totals an invoice", "raises unexpectedly"]);
    } },
  { file: "bun_order_fail.txt", tool: "bun test", n: 2, check: (r) => {
      assert.deepEqual(r.failures.map((f) => f.subject),
        ["cart > totals an invoice", "raises unexpectedly"]);
      assert.equal(r.failures[0].line, 5);
      assert.equal(r.failures[0].message, "expect(received).toBe(expected)\nExpected: 6\nReceived: 5");
      assert.equal(r.failures[1].line, 10);
      assert.equal(r.failures[1].message, "fixture exploded");
      // the run's own tally is not a test's assertion
      assert.doesNotMatch(JSON.stringify(r.failures), /\d+ (?:pass|fail)\b/);
      // nor is bun's banner, which sits above the first block
      assert.doesNotMatch(JSON.stringify(r.failures), /bun test v/);
    } },
  { file: "deno_fail.txt", tool: "deno test", n: 2, check: (r) => {
      // real `deno test` run. Unsupported before: it fell through to the generic
      // guess, which reported three "errors" - two real failures plus deno's own
      // "error: Test failed" tally, which is a verdict, not a failure.
      assert.equal(r.summary, "2 failed, 1 passed");
      const f = r.failures[0];
      assert.equal(f.title, "invoice total");
      assert.equal(f.file, "./math_test.ts");
      assert.equal(f.line, 4);
      assert.match(f.message, /AssertionError: Values are not equal/);
      assert.match(f.message, /1049/);
      assert.ok(!r.failures.some((g) => /Test failed/.test(g.message)),
        "deno's final verdict is not a failure of its own");
      // the frames are inside the assert library, not the user's code
      assert.ok(!/jsr\.io/.test(f.message));
    } },
  // `--junit-path=-` is not a reporter choice - it writes the XML to stdout ALONGSIDE
  // whichever reporter is running, so one run arrives twice in one log. Both of these
  // are one real run of two tests, one failing. Counting both renderings reported that
  // single failure as two, and with the TAP reporter it also showed the test twice.
  // An attribute value may contain newlines, and deno's does: it puts the whole assertion
  // - diff and all - in the failure's `message`. A reader that wanted the start tag on
  // one line found no tag there, so the FIRST failure of every deno JUnit run was
  // skipped and only the ones whose message happened to fit on one line were read.
  { file: "denotest_junit_multiline_fail.txt", tool: "deno test", n: 2, check: (r) => {
      assert.deepEqual(r.failures.map((f) => f.subject),
        ["cart > totals an invoice", "cart > raises unexpectedly"]);
      assert.deepEqual(r.failures.map((f) => f.line), [3, 7]);
      // the value diff is part of the answer, and the pretty reporter keeps it
      assert.equal(r.failures[0].message, "AssertionError: Values are not equal.\n-   5\n+   6");
      assert.equal(r.failures[1].message, "Error: fixture exploded");
    } },
  { file: "denotest_junit_text_same_fail.txt", tool: "deno test", n: 2, check: (r) => {
      assert.deepEqual(r.failures.map((f) => f.subject),
        ["cart > totals an invoice", "cart > raises unexpectedly"]);
      assert.deepEqual(r.failures.map((f) => f.line), [3, 7]);
    } },
  { file: "denotest_junit_alongside_fail.txt", tool: "deno test", n: 1, check: (r) => {
      assert.equal(r.summary, "1 failed, 1 passed", "the run was counted twice");
      assert.equal(r.failures[0].title, "adds");
      assert.equal(r.failures[0].file, "./reporter_test.ts");
    } },
  { file: "denotest_tap_junit_fail.txt", tool: "deno test", n: 1, check: (r) => {
      // TAP has no column and JUnit does, so the shared de-duplication - which keys on
      // the location - could not join them, and the same test was listed twice.
      assert.equal(r.summary, "1 failed, 1 passed");
      assert.equal(r.failures[0].title, "adds");
      assert.match(r.failures[0].message, /Error: expected three/);
    } },
  { file: "denotest_reporter_plain_fail.txt", tool: "deno test", n: 1, check: (r) => {
      assert.equal(r.failures[0].title, "adds");
      assert.equal(r.failures[0].file, "./reporter_test.ts");
      assert.equal(r.failures[0].line, 1);
      assert.equal(r.failures[0].col, 6);
    } },
  // Deno's TAP reporter embeds its diagnostic as JSON inside the YAML block. It used
  // to become two generic failures: the JSON plumbing and Deno's final verdict.
  { file: "denotest_reporter_tap_fail.txt", tool: "deno test", n: 1, check: (r) => {
      assert.equal(r.summary, "1 failed, 0 passed");
      assert.equal(r.failures[0].title, "adds");
      assert.equal(r.failures[0].file, "./reporter_test.ts");
      assert.equal(r.failures[0].line, 1);
      assert.match(r.failures[0].message, /Error: expected three/);
      assert.doesNotMatch(JSON.stringify(r.failures), /file:\/\/\/|"severity":"fail"/);
    } },
  { file: "denotest_reporter_junit_fail.txt", tool: "deno test", n: 1, check: (r) => {
      assert.equal(r.summary, "1 failed, 0 passed");
      assert.equal(r.failures[0].title, "adds");
      assert.equal(r.failures[0].file, "./reporter_test.ts");
      assert.equal(r.failures[0].line, 1);
      assert.equal(r.failures[0].col, 6);
      assert.match(r.failures[0].message, /Error: expected three/);
      assert.doesNotMatch(JSON.stringify(r.failures), /<failure|&quot;|file:\/\/\//);
    } },
  { file: "denotest_reporter_skipped_plain_fail.txt", tool: "deno test", n: 1, check: (r) => {
      assert.equal(r.summary, "1 failed, 1 passed");
      assert.equal(r.failures[0].title, "fails");
    } },
  { file: "denotest_reporter_skipped_junit_fail.txt", tool: "deno test", n: 1, check: (r) => {
      assert.equal(r.summary, "1 failed, 1 passed");
      assert.equal(r.failures[0].title, "fails");
      assert.equal(r.failures[0].file, "./reporter_test.ts");
      assert.equal(r.failures[0].line, 9);
      assert.equal(r.failures[0].col, 6);
    } },
  { file: "denotest_reporter_skipped_tap_fail.txt", tool: "deno test", n: 1, check: (r) => {
      assert.equal(r.summary, "1 failed, 1 passed");
      assert.equal(r.failures[0].title, "fails");
      assert.equal(r.failures[0].file, "./reporter_test.ts");
      assert.equal(r.failures[0].line, 9);
    } },
  // Bare TAP: what every harness emits when you ask for TAP and nothing more. It has no
  // version line and no YAML block, so tap.js - which reads node-tap's TAP 14 - required
  // both and matched neither. `mocha --reporter tap` produced nothing at all, and Perl's
  // came out of the perl parser as two failures whose whole message was "#".
  //
  // The mocha capture is one real run; its `spec` form of the same run reports the same
  // test at the same place, which is what these assertions pin.
  { file: "mocha_tap_fail.txt", tool: "tap", n: 1, check: (r) => {
      assert.equal(r.summary, "1 failed, 1 passed");
      assert.equal(r.failures[0].title, "shop invoice total");
      assert.equal(r.failures[0].file, "test_shop.cjs", "the indented stack carries the location");
      assert.equal(r.failures[0].line, 4);
      assert.equal(r.failures[0].col, 12);
      assert.match(r.failures[0].message, /1049 !== 1050/);
    } },
  // One real mocha run in its two machine formats. `--reporter json` produced nothing at
  // all - mocha pretty-prints it across forty lines, so unlike eslint's or jest's it
  // cannot be found by scanning for a line that parses. `--reporter xunit` was claimed by
  // the node parser, because the stack inside <failure> looks like one of node's: the
  // failure came back titled "AssertionError [ERR_ASSERTION]" with the test's name
  // nowhere, no count of what passed, and XML entities left in the message.
  //
  // The spec reporter reports this same run as `shop invoice total` at test_shop.cjs:4:12
  // with "1 failing, 1 passing", which is what these two are checked against.
  { file: "mocha_json_fail.txt", tool: "mocha", n: 1, check: (r) => {
      assert.equal(r.summary, "1 failing, 1 passing");
      assert.equal(r.failures[0].title, "shop invoice total", "fullTitle, not the bare test name");
      assert.equal(r.failures[0].file, "test_shop.cjs", "the frame that threw, not the whole file");
      assert.equal(r.failures[0].line, 4);
      assert.equal(r.failures[0].col, 12);
      assert.equal(r.failures[0].message, "Expected values to be strictly equal:\n1049 !== 1050");
    } },
  { file: "mocha_xunit_fail.txt", tool: "mocha", n: 1, check: (r) => {
      assert.equal(r.summary, "1 failing, 1 passing", "mocha files an assertion under errors, not failures");
      assert.equal(r.failures[0].title, "shop invoice total", "classname and name together");
      assert.equal(r.failures[0].line, 4);
      assert.equal(r.failures[0].col, 12);
      // "at Context.&#x3C;anonymous&#x3E;" - numeric references, not the named five.
      assert.doesNotMatch(JSON.stringify(r.failures), /&#x|&lt;|<failure/);
    } },
  // One real vitest run in three of its reporters. `--reporter=tap` and `tap-flat` are
  // TAP 13 with a YAML block, but in vitest's own dialect - `at: "path:line:col"` on one
  // line, the class and text under `error:` - where tap.js reads node-tap's `at:` map. So
  // neither matched, and a failing run came back as one guess reading "error:".
  { file: "vitest_text_same_fail.txt", tool: "vitest", n: 1, check: (r) => {
      assert.equal(r.summary, "1 failed | 1 passed (2)");
      assert.equal(r.failures[0].title, "invoice total");
      assert.equal(r.failures[0].file, "shop.test.js");
      assert.deepEqual([r.failures[0].line, r.failures[0].col], [3, 16]);
    } },
  { file: "vitest_tapflat_fail.txt", tool: "vitest", n: 1, check: (r) => {
      assert.equal(r.summary, "1 failed | 1 passed (2)", "the plan and the results give the counts");
      // tap-flat names the test "file > test"; the file is already the location.
      assert.equal(r.failures[0].title, "invoice total");
      assert.deepEqual([r.failures[0].line, r.failures[0].col], [3, 16]);
      // TAP prints the absolute path where the pretty reporter prints what you typed.
      assert.equal(r.failures[0].file, "/home/dev/vitest/shop.test.js");
      assert.match(r.failures[0].message, /AssertionError: expected 1049 to be 1050/);
    } },
  { file: "vitest_tap_fail.txt", tool: "vitest", n: 1, check: (r) => {
      // The nested reporter wraps the file's tests in a result of its own, opened with a
      // brace. Counting that roll-up as well would report one failing test as two.
      assert.equal(r.failures.length, 1);
      assert.equal(r.failures[0].title, "invoice total");
      assert.doesNotMatch(r.failures[0].title, /time=|\{|shop\.test\.js/);
    } },
];

let pass = 0, fail = 0;
for (const result of [runCases(CASES), agreeAcrossFormats([
  ["jest", ["jest_gh_text_same_fail.txt", "jest_github_fail.txt"]],
  ["vitest", ["vitest_reporters_text_same_fail.txt", "vitest_junit_fail.txt",
    "vitest_github_fail.txt"]],
  // The JSON report carries the assertion's own message and no rendered diff - the diff
  // is drawn by the reporters, not stored. What it does carry is checked below.
  ["vitest json", ["vitest_reporters_text_same_fail.txt", "vitest_json_fail.txt"], ["message"]],
  ["deno test", ["denotest_junit_text_same_fail.txt", "denotest_junit_multiline_fail.txt"]],
  ["playwright", ["playwright_list_same_fail.txt", "playwright_dot_fail.txt", "playwright_github_fail.txt",
    "playwright_json_fail.txt", "playwright_junit_fail.txt"]],
  ["mocha reports", ["mocha_json_same_fail.txt", "mocha_json_stream_fail.txt"]],
  // The console reporters print the diff under the assertion; the reports do not.
  ["mocha console and reports", ["mocha_spec_same_fail.txt", "mocha_dot_fail.txt", "mocha_json_same_fail.txt"], ["message"]],
  // Colour changes how bun marks a failure, not which tests failed.
  ["bun colour", ["bun_color_plain_same_fail.txt", "bun_color_fail.txt"]],
])]) {
  pass += result.pass;
  fail += result.fail;
}


// The same shape of silence for vitest: its JSON report stores the assertion's message
// and not the diff its reporters draw, so what the document does carry has to be the
// first line of what they print, exactly.
try {
  const pretty = analyse(fx("vitest_reporters_text_same_fail.txt")).failures;
  const json = analyse(fx("vitest_json_fail.txt")).failures;
  assert.equal(pretty.length, json.length);
  for (let i = 0; i < pretty.length; i++) {
    assert.equal(json[i].message, pretty[i].message.split("\n")[0],
      `${json[i].subject}: the document says something else on the first line`);
  }
  // ...and the reporters really do add more than the document has.
  assert.ok(pretty.some((f) => f.message.includes("\n")), "no reporter drew a diff");
  console.log("  ok   vitest's JSON report is the first line of what its reporters print");
  pass++;
} catch (e) {
  console.log(`  FAIL vitest message silence\n       ${e.message}`);
  fail++;
}

// A truncated log can contain only the parent failure. Keep that diagnosis, and
// ensure failures in a previous, unrelated suite do not cause it to be dropped.
try {
  const raw = fx("nodetest_nested_fail.txt");
  const parent = raw.slice(raw.indexOf("\nnot ok 1 - arithmetic") + 1);
  for (const input of [parent, "# Subtest: arithmetic\n" + parent,
    fx("nodetest_fail.txt") + "\n# Subtest: arithmetic\n" + parent]) {
    const r = analyse(input);
    const kept = r.failures.filter((f) => f.title === "arithmetic");
    assert.equal(kept.length, 1, "a parent without captured children must remain visible");
    assert.equal(kept[0].message, "2 subtests failed");
  }
  // The same captured log must produce one annotation per actual failing test.
  const github = spawnSync(process.execPath, [cli, "--format", "github"], {
    input: raw, encoding: "utf8", env: { ...process.env, GITHUB_STEP_SUMMARY: "" },
  });
  assert.equal(github.status, 0);
  assert.equal((github.stdout.match(/^::error /gm) ?? []).length, 3);
  assert.doesNotMatch(github.stdout, /title=(arithmetic|first operations)/);
  const json = spawnSync(process.execPath, [cli, "--json"], { input: raw, encoding: "utf8" });
  assert.equal(json.status, 0);
  assert.equal(JSON.parse(json.stdout).failures.length, 3);
  console.log("  ok   Node parent summaries are removed only when child failures are captured");
  pass++;
} catch (e) { console.log(`  FAIL Node parent summaries\n       ${e.message}`); fail++; }

// Node's reporters expose the same failure at different levels of detail. TAP and spec
// name the test declaration; JUnit and dot only expose the throwing frame. They must
// still agree on the test, message, tool, and counts the format actually carries.
try {
  const reports = Object.fromEntries(["tap", "spec", "junit", "dot"].map((name) =>
    [name, analyse(fx(`nodetest_reporter_${name}_fail.txt`))]));
  for (const [name, report] of Object.entries(reports)) {
    assert.equal(report.tool, "node --test", `${name} lost the Node test identity`);
    assert.equal(report.failures[0].title, reports.tap.failures[0].title);
    assert.equal(report.failures[0].message, reports.tap.failures[0].message,
      `${name} changed the diagnostic`);
  }
  assert.equal(reports.tap.summary, "1 failed, 1 passed");
  assert.equal(reports.spec.summary, reports.tap.summary);
  assert.equal(reports.junit.summary, reports.tap.summary);
  assert.equal(reports.dot.summary, "1 failed", "dot cannot distinguish passes from skips");
  assert.equal(reports.spec.failures[0].line, reports.tap.failures[0].line,
    "spec and TAP disagree on the test declaration");
  assert.equal(reports.junit.failures[0].line, 7);
  assert.equal(reports.dot.failures[0].line, 7);
  console.log("  ok   Node TAP, spec, JUnit, and dot reporters preserve the facts they expose");
  pass++;
} catch (e) { console.log(`  FAIL Node reporters\n       ${e.message}`); fail++; }

// A machine format is only worth reading if it says the same thing as the human one.
// Deno's machine reporters carry the same test location and message as its pretty
// report: TAP wraps JSON in YAML, while JUnit serializes the facts as XML.
try {
  const tap = analyse(fx("denotest_reporter_tap_fail.txt"));
  const junit = analyse(fx("denotest_reporter_junit_fail.txt"));
  const text = analyse(fx("denotest_reporter_plain_fail.txt"));
  const facts = (r) => r.failures.map((f) =>
    [f.file, f.line, f.title, f.subject, f.severity, f.message]);
  assert.equal(tap.tool, text.tool);
  assert.equal(tap.summary, text.summary);
  assert.deepEqual(facts(tap), facts(text), "Deno TAP and pretty reports disagree");
  assert.equal(junit.tool, text.tool);
  assert.equal(junit.summary, text.summary);
  assert.deepEqual(facts(junit), facts(text), "Deno JUnit and pretty reports disagree");
  const skippedJunit = analyse(fx("denotest_reporter_skipped_junit_fail.txt"));
  const skippedTap = analyse(fx("denotest_reporter_skipped_tap_fail.txt"));
  const skippedText = analyse(fx("denotest_reporter_skipped_plain_fail.txt"));
  assert.equal(skippedJunit.summary, skippedText.summary,
    "Deno JUnit counts an ignored test as passed");
  assert.equal(skippedTap.summary, skippedText.summary,
    "Deno TAP counts an ignored test as passed");
  assert.deepEqual(facts(skippedJunit), facts(skippedText),
    "Deno JUnit with a skipped test and its pretty report disagree");
  assert.deepEqual(facts(skippedTap), facts(skippedText),
    "Deno TAP with a skipped test and its pretty report disagree");
  console.log("  ok   deno TAP and JUnit reporters say what the pretty report says");
  pass++;
} catch (e) { console.log(`  FAIL deno machine reporters vs pretty\n       ${e.message}`); fail++; }

// Jest sends the human report to stderr and its JSON document to stdout. These paired
// captures are the same invocations, not lookalike hand-written examples: the machine
// path must preserve the assertion facts, status tally and suite-load diagnosis.
try {
  const json = analyse(fx("jest_json_statuses_fail.txt"));
  const text = analyse(fx("jest_text_statuses_fail.txt"));
  const facts = (r) => r.failures.map((f) =>
    [f.file, f.line, f.col, f.title, f.severity, f.message]);
  assert.equal(json.tool, text.tool);
  assert.equal(json.summary, text.summary);
  assert.deepEqual(facts(json), facts(text),
    "--json and the human report disagree about the failed assertion");

  const jsonSuite = analyse(fx("jest_json_suite_fail.txt"));
  const textSuite = analyse(fx("jest_text_suite_same_fail.txt"));
  assert.equal(jsonSuite.summary, textSuite.summary);
  assert.equal(jsonSuite.failures[0].title, textSuite.failures[0].title);
  assert.equal(jsonSuite.failures[0].message, textSuite.failures[0].message);
  assert.ok(jsonSuite.failures[0].file.endsWith(`/${textSuite.failures[0].file}`),
    "the absolute JSON name and relative terminal name do not identify the same file");

  const several = analyse(fx("jest_json_statuses_fail.txt") + "\n" +
    fx("jest_json_assertions_fail.txt"));
  assert.equal(several.failures.length, 4, "a second Jest JSON document was ignored");
  assert.equal(several.summary, undefined,
    "separate invocation tallies must not be presented as one run's tally");

  const notJest = analyse('{"success":false,"testResults":[]}');
  assert.notEqual(notJest?.tool, "jest", "an arbitrary object with testResults was claimed as Jest");
  console.log("  ok   jest --json says what the human report says");
  pass++;
} catch (e) { console.log(`  FAIL jest json vs text\n       ${e.message}`); fail++; }
// Two machine formats of one run have to agree with each other, and with what the human
// reporter says about it. They differ only in how much of the diff each one carries.
try {
  const json = analyse(fx("mocha_json_fail.txt"));
  const xunit = analyse(fx("mocha_xunit_fail.txt"));
  const where = (r) => [r.tool, r.summary, r.failures[0].file, r.failures[0].line,
    r.failures[0].col, r.failures[0].title];
  assert.deepEqual(where(xunit), where(json), "mocha's json and xunit reports disagree");
  assert.equal(xunit.failures[0].message.split("\n")[0], json.failures[0].message.split("\n")[0]);
  console.log("  ok   mocha's machine formats agree with each other");
  pass++;
} catch (e) { console.log(`  FAIL mocha json vs xunit\n       ${e.message}`); fail++; }

// Three reporters, one run. They differ only in how the path is written.
try {
  const text = analyse(fx("vitest_text_same_fail.txt"));
  const flat = analyse(fx("vitest_tapflat_fail.txt"));
  const nested = analyse(fx("vitest_tap_fail.txt"));
  const facts = (r) => [r.tool, r.summary, r.failures[0].line, r.failures[0].col,
    r.failures[0].title, r.failures[0].message];
  assert.deepEqual(facts(flat), facts(text), "vitest's tap-flat and pretty reports disagree");
  assert.deepEqual(facts(nested), facts(text), "vitest's nested tap and pretty reports disagree");
  console.log("  ok   vitest's TAP reporters say what its pretty one says");
  pass++;
} catch (e) { console.log(`  FAIL vitest tap vs pretty\n       ${e.message}`); fail++; }

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
