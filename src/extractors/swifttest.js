// `swift test` runs two test libraries, and a package may hold tests written with either.
//
// XCTest writes a failure as a location, the test between brackets, and what went wrong:
//
//   Tests/ShopTests/InvoiceTests.swift:16: error: -[ShopTests.InvoiceTests testTotalsAnInvoice] : XCTAssertEqual failed: ("1049") is not equal to ("1050")
//   Test Case '-[ShopTests.InvoiceTests testTotalsAnInvoice]' failed (0.000 seconds).
//     Executed 4 tests, with 3 failures (1 unexpected) in 0.041 (0.048) seconds
//
// swift-testing, the library Swift 6 added, writes each issue under the test it belongs to,
// with any comment of its own on the line below:
//
//   ✘ Test roundsUp() recorded an issue at CheckoutTests.swift:16:9: Expectation failed: (Invoice(lines: [1], tax: 0).total() → 1) == 2
//   ↳ rounding is not decided
//   ✘ Test run with 3 tests in 1 suite failed after 0.001 seconds with 3 issues.
//
// A test that crashes ends the run where it stands: the last test to start never finishes,
// the runtime says what it hit, and swiftpm reports the signal. That test is the failure -
// the runtime's own frame is inside the standard library and points at nobody's code.
import { counted } from "../util.js";
import { withSource } from "../ownership.js";

// The bracketed test is macOS's shape. Linux writes `InvoiceTests.testTotals :` instead, and
// nothing here reads it: there is no capture of a Linux run in the corpus to hold it to.
const XCTEST_RE = /^(.+?):(\d+): error: -\[([\w.]+) (\w+)\][^\S\n]*:[^\S\n]*(.*)$/;
const CASE_RE = /^Test Case '-\[([\w.]+) (\w+)\]' (started|passed|failed)\b/;
// XCTest prints its tally even where no test of its own ran, and "Executed 0 tests, with 0
// failures" over swift-testing's failures reads as though nothing happened.
const XCTEST_TALLY_RE = /^[^\S\n]*Executed ([1-9]\d*) tests?, with \d+ failures?(?:[^\S\n]*\(\d+ unexpected\))?/m;
const ISSUE_RE = /^✘ Test (.+?) recorded an issue at (.+?):(\d+):(\d+):[^\S\n]*(.*)$/;
const COMMENT_RE = /^↳[^\S\n]*(.*)$/;
const TESTING_TALLY_RE = /^✘ Test run with (\d+) tests? in (\d+) suites? failed(?:[^\S\n]+after[^\S\n]+[\d.]+[^\S\n]+seconds?)?[^\S\n]+with (\d+) issues?/m;
// What the runtime prints as it dies, and what swiftpm says after it.
const FATAL_RE = /^(?:Fatal error|Swift runtime failure|Precondition failed|Assertion failed)\b[^\S\n]*:?[^\S\n]*(.*)$/;
const SIGNAL_RE = /^error: Exited with unexpected signal code (\d+)/m;

export default {
  name: "swift test",
  // Strings a log has to hold for this parser to read anything from it - see src/router.js.
  signals: ["error: -[", "Test Case '-[", "recorded an issue at", "Executed "],
  category: "test",
  commands: ["swift", "xcodebuild"],

  // A failure of either library, or a test that started and a signal that ended the run.
  detect: (s) => XCTEST_RE.test(s.split("\n").find((l) => XCTEST_RE.test(l)) ?? "") ||
    ISSUE_RE.test(s.split("\n").find((l) => ISSUE_RE.test(l)) ?? "") ||
    (SIGNAL_RE.test(s) && /^Test Case '-\[/m.test(s)),

  extract(s) {
    const lines = s.split("\n");
    const failures = [];
    let started = null, startedAt = -1, finished = true;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const state = line.match(CASE_RE);
      if (state) {
        // The last test to start, so that a crash can be named. XCTest says when each one
        // finishes, whether it passed or failed.
        if (state[3] === "started") { started = `${state[1]}.${state[2]}`; startedAt = i; finished = false; }
        else finished = true;
        continue;
      }
      const xctest = line.match(XCTEST_RE);
      if (xctest) {
        const test = `${xctest[3]}.${xctest[4]}`;
        // "failed - " is XCTFail's own prefix for the message it was given.
        const message = xctest[5].replace(/^failed[^\S\n]+-[^\S\n]+/, "").trim();
        failures.push(withSource({
          file: xctest[1], line: +xctest[2],
          title: test, subject: test, severity: "error",
          message: message || "the test failed",
        }, i, i + 1));
        continue;
      }
      const issue = line.match(ISSUE_RE);
      if (issue) {
        // A comment the test gave the expectation is written under it, one line each.
        const said = [issue[5].trim()];
        let end = i + 1;
        while (end < lines.length && COMMENT_RE.test(lines[end])) {
          said.push(lines[end].match(COMMENT_RE)[1].trim());
          end++;
        }
        failures.push(withSource({
          file: issue[2], line: +issue[3], col: +issue[4],
          title: issue[1], subject: issue[1], severity: "error",
          message: said.filter(Boolean).join("\n") || "the expectation failed",
        }, i, end));
        i = end - 1;
      }
    }

    // A run that died takes its last test with it, and says so nowhere else.
    const signal = s.match(SIGNAL_RE);
    if (!failures.length && signal && started && !finished) {
      // What the runtime said after that test started, and not a line belonging to whatever
      // else is in the log: PHP writes "Fatal error:" too, and a log holding both handed the
      // crash PHP's words.
      const from = startedAt + 1;
      const runtime = lines.slice(from).findIndex((l) => FATAL_RE.test(l.replace(/^.*?:\d+:[^\S\n]*/, "")));
      const fatal = runtime < 0 ? -1 : from + runtime;
      const said = fatal >= 0 ? lines[fatal].replace(/^.*?:\d+:[^\S\n]*/, "").trim() : `exited with unexpected signal code ${signal[1]}`;
      failures.push(withSource({
        title: started, subject: started, severity: "error", message: said,
      }, fatal >= 0 ? fatal : 0, (fatal >= 0 ? fatal : 0) + 1));
    }

    if (!failures.length) return null;
    // Each library counts its own run; a package with tests of both kinds prints both.
    const xctest = s.match(XCTEST_TALLY_RE)?.[0].trim();
    const testing = s.match(TESTING_TALLY_RE);
    const said = [xctest, testing && `${counted(+testing[1], "test")} in ${counted(+testing[2], "suite")} failed with ${counted(+testing[3], "issue")}`]
      .filter(Boolean);
    return { tool: "swift test", summary: said.join(" — ") || undefined, failures };
  },
};
