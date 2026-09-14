// Hostile logs.
//
// A log is untrusted input, so what it holds cannot decide whether reading it finishes.
// Each shape below once made a reader take time that grew as the square of the log:
// a reader walked from every line of one kind to the end of the log, or re-read the
// same stretch once per line. None of them needed much input. 50 KB of lines that each
// open a brace took 87 seconds, and 32,000 lines of oxlint parse errors took 49.
//
// Timing a test against the clock fails on a slow machine and passes on a fast one, so
// every case here compares the reader with itself. Four times the log may cost about
// four times the time, where a reader that re-reads per line costs sixteen - the bound is
// eight. And a hostile log may cost at most twenty times an ordinary log of the same size
// read on the same machine a moment earlier. The budget that caps locating ranges is
// tested without a clock at all.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyse } from "../src/index.js";
import { unixLine } from "../src/extractors/stylelint.js";
import { issueLine } from "../src/extractors/golangci.js";
import { gccLine } from "../src/extractors/shellcheck.js";
import { raiseLine } from "../src/extractors/ruby.js";
import { FRAME_WITH_CALL } from "../src/extractors/node.js";
import { FAILED_TALLY } from "../src/extractors/junitjvm.js";

const here = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const test = (name, fn) => {
  try {
    const returned = fn();
    // This runner is synchronous. An async body returns a promise it would never await,
    // so every assertion inside becomes an unhandled rejection and the test passes
    // whatever it finds. One written that way sat green against the exact bug it was
    // meant to catch, so the shape is refused rather than trusted.
    if (returned && typeof returned.then === "function") {
      throw new Error("test body returned a promise; this runner does not await, so nothing in it would be checked");
    }
    console.log(`  ok   ${name}`); pass++;
  } catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
};

// A read that takes a fraction of a millisecond is mostly the clock and whatever else the
// process happens to be doing, and the ratio of two of them says nothing about growth: once
// a parser is asked only about logs it could read, a long line of node frames read in a
// third of a millisecond, and four times as much "took eleven times as long". So a read is
// repeated until twenty milliseconds have passed, and its time is the average. A read that
// is slow on its own - which a quadratic one is - is still taken once.
//
// Every parser is asked about every log here. A parser is only asked about a log holding
// one of its signals, and most of these shapes hold none - a log of lines that each open a
// brace names no JSON report - so with the router on they would never reach the readers
// they exist to hold to account. A log that holds the shape and a signal does.
const FLOOR_MS = 20;
const took = (text) => {
  let runs = 0;
  const at = performance.now();
  do { analyse(text, { route: false }); runs++; } while (performance.now() - at < FLOOR_MS);
  return (performance.now() - at) / runs;
};
const ms = (t) => (t < 10 ? t.toFixed(1) : Math.round(t));
const fastest = (text, runs) => Math.min(...Array.from({ length: runs }, () => took(text)));

/** Reading `grow(4n)` costs about four times reading `grow(n)`, not sixteen. The larger
 *  log is read once before it is read again, so a reader that has gone quadratic fails
 *  after one slow read instead of three. */
function linear(grow, n) {
  const small = fastest(grow(n), 5);
  const big = grow(4 * n - 3);
  let large = took(big);
  if (large < small * 8) large = Math.min(large, fastest(big, 2));
  assert.ok(large < small * 8,
    `${ms(small)}ms for the log, ${ms(large)}ms for four times as much - x${(large / small).toFixed(1)}`);
}

/** Reading `text` costs at most twenty times reading build chatter of the same size. One
 *  slow read is enough to fail. */
function nearOrdinary(text) {
  const lines = [];
  for (let size = 0, i = 0; size < text.length; i++) {
    lines.push(`  vite:build transforming src/components/Widget${i}.tsx +2ms`);
    size += lines[lines.length - 1].length + 1;
  }
  const ordinary = fastest(lines.join("\n"), 3);
  let hostile = took(text);
  if (hostile < ordinary * 20) hostile = Math.min(hostile, fastest(text, 2));
  assert.ok(hostile < ordinary * 20,
    `${ms(hostile)}ms against ${ms(ordinary)}ms for ordinary output of the same size - x${(hostile / ordinary).toFixed(1)}`);
}

// An even number of identical lines is an exact retry of itself and collapses before any
// parser sees it, so every repeated shape is repeated an odd number of times.
const repeat = (line) => (n) => Array(n).fill(line).join("\n");

console.log("\nhostile logs");

// JIT compilation belongs to whichever test runs first, and it is not what is measured.
analyse(readFileSync(join(here, "fixtures", "pytest_fail.txt"), "utf8"));

test("lines that each open a brace", () => {
  // Every bracket that opens a line is where a JSON document may start, and each was
  // scanned from to wherever its brackets balanced - here, never.
  linear(repeat("{"), 3001);
});

test("start tags that never close", () => {
  // `<testcase ...>([\s\S]*?)</testcase>` looks to the end of the log for the closing tag
  // from every start tag that has none.
  linear(repeat(`    <testcase name="errcheck" classname="main.go:10:15">`), 1201);
});

test("traceback headers with no exception under them", () => {
  // A traceback steps over a header inside it, so every header's block ran to the end.
  linear(repeat("Traceback (most recent call last):"), 1201);
});

test("vitest suite headers with nothing under them", () => {
  // A block reads on past its assertion to the next failure header or location.
  linear(repeat(" FAIL  t/crash.test.js [ t/crash.test.js ]"), 801);
});

test("oxlint parse errors, which name no rule", () => {
  // A drawn heading without a rule is oxlint's only if every line below it down to the
  // tally is part of the drawing - asked by walking there from each heading.
  const report = (n) => [
    ...Array.from({ length: n }, () => ["  x Expected `,` or `)` but found `{`", "   ,-[src/broken.js:1:28]"]).flat(),
    "", "Found 0 warnings and 1 error.", "Finished in 3ms on 1 file with 96 rules using 8 threads.",
  ].join("\n");
  linear(report, 801);
});

test("yamllint findings with no filename above them", () => {
  // Whether a filename opened the block was asked of every finding by looking back over
  // every line above it.
  linear(repeat(`  1:1       warning  missing document start "---"  (document-start)`), 4001);
});

test("thousands of rust panics", () => {
  // Whether the run was a build script, a test run or a program was asked of the whole
  // log once per panic.
  const panic = "thread 'tests::invoice_total' (7732159) panicked at src/lib.rs:11:9:\nassertion `left == right` failed";
  linear(repeat(panic), 801);
});

test("numbers that each claim the rest of the log", () => {
  // swiftc's parseable output puts a byte count above each record, and every such count
  // was decoded and parsed to see whether a record was there.
  const claims = (n) => {
    const lines = [];
    let after = 0;
    for (let i = 0; i < n; i++) {
      const claim = String(Math.max(after - 1, 1));
      lines.push(claim);
      after += claim.length + 1;
    }
    return lines.reverse().join("\n") + "\n";
  };
  linear(claims, 16001);
});

test("one finding printed thousands of times", () => {
  // Each copy is one more place the finding was read from, and joining a place into the
  // ones kept compares it with each of them.
  linear(repeat("lint_me.py:1:8: F401 'os' imported but unused"), 4001);
});

test("the first two lines of a terraform report, over and over", () => {
  // terraform balanced the braces of every report-looking line down to wherever they
  // balanced, and these never do.
  linear(repeat(`{\n  "format_version": "1.0",`), 401);
});

test("two tools whose findings share no text", () => {
  // Each reading of a second tool was compared with every reading of the first.
  const log = (n) => {
    const lines = [];
    for (let i = 0; i < n; i++) {
      lines.push(`src/mod_${i % 997}.py:${(i % 400) + 1}:1: F401 'os' imported but unused`);
      lines.push(`src/mod_${(i * 7) % 991}.py:${(i % 350) + 1}: error: Name "value_${i}" is not defined  [name-defined]`);
    }
    lines.push(`Found ${n} errors in 991 files (checked 991 source files)`);
    return lines.join("\n");
  };
  linear(log, 3000);
});

// eslint's table and its JSON report, the same message on every line of both - "Unexpected
// any" is every finding in plenty of TypeScript runs - at locations that do not coincide,
// so neither reading is an exact copy of the other.
function tableAndReport(n, fixText = null) {
  const message = "Unexpected any. Specify a different type";
  const table = ["", "/app/src/types.ts"];
  for (let i = 0; i < n; i++) table.push(`  ${i + 1}:10  error  ${message}  @typescript-eslint/no-explicit-any`);
  table.push("", `\u2716 ${n} problems (${n} errors, 0 warnings)`, "");
  const messages = Array.from({ length: n }, (_, i) => ({
    ruleId: "@typescript-eslint/no-explicit-any", severity: 2, message: `${message}.`, line: i + 100001, column: 10,
  }));
  if (fixText) messages[0].fix = { range: [1, 2], text: fixText };
  return [...table, JSON.stringify([{ filePath: "/app/src/other.ts", messages, errorCount: n, warningCount: 0 }])].join("\n");
}

test("the same message across two tools, most of it on one line", () => {
  // When ranges were guessed, every finding was placed by sorting the lines that mention
  // it, and every comparison in the sort searched the report line - the whole JSON
  // document - again: 2,001 findings, 471 KB, took three minutes. The comparison of the
  // two tools' readings that ranges decide is still quadratic in principle.
  nearOrdinary(tableAndReport(801));
});

test("a location search inside a long unbroken token", () => {
  // Guessing a range asked whether a line writes `file.ext:line:col`, which backtracked
  // through every run of path characters from each position in it; a fix's 5,000-character
  // token cost that per comparison, per finding.
  nearOrdinary(tableAndReport(51, "x".repeat(5000)));
});

// ------------------------------------------------------------- one long line

// A line pattern that finds its end by trying every place its start could stop - a lazy
// file name, then a lazy message, then a tail held to the end of the line - read a long
// line again from every colon in it. Nothing about the lines that trip it is unusual
// except that there is one of them and it is long.
const oneLine = (unit) => (n) => Array(n).fill(unit).join(" ");

test("one long line of stylelint-shaped findings", () => {
  linear(oneLine("cJSON.c:2600:34: error: too few arguments to function call, single argument hooks was not specified"), 401);
});

test("one long line of golangci-lint-shaped findings", () => {
  linear(oneLine("main.go:13:14: printf: fmt.Printf format %d has arg many of wrong type string"), 401);
});

test("one long line of shellcheck-shaped findings", () => {
  linear(oneLine("bad.c:4:5: error: call to undeclared function 'undefined_function'; ISO C99 and later do not support it"), 401);
});

test("one long line of ruby frames", () => {
  linear(oneLine("\tfrom /usr/lib/ruby/2.6.0/rubygems/core_ext/kernel_require.rb:54:in `require'"), 401);
});

test("one long line of node frames with calls in them", () => {
  linear(oneLine("    at Microsoft.VisualStudio.TestTools.UnitTesting.Assert.AreEqual[T](T expected, T actual, IEqualityComparer`1 comparer, String message"), 401);
});

test("one long line of surefire tallies", () => {
  linear(oneLine("[INFO] Tests run: 45, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.015 s -- in org.json.junit.JSONParserConfigurationTest"), 401);
});

// Each replacement answers exactly what its pattern answered - every group, on lines built
// to nearly match and on lines of loose pieces, including the line terminators `.` refuses
// to cross.
let seed = 2027;
const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const pick = (a) => a[Math.floor(rand() * a.length)];
const gap = () => pick(["", " ", "  ", "\t", " \t ", "\u2028", "\r", "   "]);
const junk = () => pick(["", "x", ":", "1", ":1:2:", "(", ")", "[", "]", "'", "`", "':", ".go", "./", ".\\", "\u2028", "\u2029", "\r", " ", "SC", "Error", "a:b", "at ", "<<<", "Time elapsed:"]);
const agrees = (name, expected, replacement, near) => {
  const shown = (m) => (m ? JSON.stringify([...m]) : "null");
  const wrong = [];
  let matched = 0;
  for (let k = 0; k < 20000 && wrong.length < 3; k++) {
    let line = near();
    if (rand() < 0.5) { const at = Math.floor(rand() * (line.length + 1)); line = line.slice(0, at) + junk() + line.slice(at); }
    let loose = "";
    for (let i = 1 + Math.floor(rand() * 10); i > 0; i--) loose += junk();
    for (const text of [line, loose]) {
      const want = shown(expected(text)), got = shown(replacement(text));
      if (want !== "null") matched++;
      if (want !== got) wrong.push(`${JSON.stringify(text)}: pattern ${want}, replacement ${got}`);
    }
  }
  assert.deepEqual(wrong, [], name);
  assert.ok(matched > 200, `${name}: only ${matched} lines matched, which tests little`);
};

const matching = (pattern) => (text) => text.match(pattern);
const testing = (pattern) => (text) => (pattern.test(text) ? [text] : null);

test("each replacement matches exactly what its pattern matched", () => {
  agrees("stylelint -f unix", matching(/^(\S.*?):(\d+):(\d+):[^\S\n]+(.+?)[^\S\n]*\(([\w-]+(?:\/[\w-]+)?)\)[^\S\n]*\[(error|warning)\][^\S\n]*$/), unixLine,
    () => pick(["a.css", "src/x y.scss", "a:b.css", ":1", ""]) + ":" + pick(["1", "12", "x"]) + ":" + pick(["2", "34", ""]) + ":" + gap() +
      pick(["msg", "m (x)", "", " ", "a:1:2: b"]) + gap() + pick(["(rule)", "(a/b)", "(a/b/c)", "()"]) + gap() + pick(["[error]", "[warning]", "[x]", ""]) + gap());
  agrees("golangci-lint", matching(/^(?:\.[\\/])?(.+?\.go):(\d+):(\d+):[^\S\n]+(.+?)[^\S\n]+\(([\w-]+)\)[^\S\n]*$/), issueLine,
    () => pick(["", "./", ".\\", "../"]) + pick(["main.go", "a.go", ".go", "x.gox", "a b.go"]) + ":" + pick(["1", "13", "x"]) + ":" + pick(["14", ""]) + ":" + gap() +
      pick(["msg", "printf: fmt (x)", "", " "]) + gap() + pick(["(govet)", "(err-check)", "()", "(a b)"]) + gap());
  agrees("shellcheck -f gcc", matching(/^(.+?):(\d+):(\d+):[^\S\n]+(error|warning|note):[^\S\n]+(.+?)[^\S\n]+\[(SC\d+)\][^\S\n]*$/), gccLine,
    () => pick(["bad.sh", " a.sh", "a:b.sh", "", "x"]) + ":" + pick(["4", "10"]) + ":" + pick(["5", ""]) + ":" + gap() + pick(["error", "warning", "note", "info"]) + ":" + gap() +
      pick(["msg", "Use x [y]", "", " "]) + gap() + pick(["[SC2086]", "[SC]", "[SC2086] x"]) + gap());
  agrees("ruby", matching(/^(.+?):(\d+):in [`'](.+?)':[^\S\n]+(.*?)[^\S\n]+\(([A-Z][\w:]*(?:Error|Exception|Interrupt|Signal|Timeout))\)$/), raiseLine,
    () => pick(["app.rb", "a b.rb", "x", "", "a:1"]) + ":" + pick(["3", "12", "x"]) + ":in " + pick(["`", "'"]) + pick(["run", "block in run", "it's", "", "a':b"]) + "':" + gap() +
      pick(["boom", "", " ", "a (b)"]) + gap() + pick(["(RuntimeError)", "(Foo::BarError)", "(Timeout)", "(error)"]));
  // These two are only ever asked whether they match.
  agrees("node frame", testing(/^[^\S\n]+at .+\(.+:\d+:\d+\)$/m), testing(FRAME_WITH_CALL),
    () => pick(["  ", " ", "\n ", "\r "]) + "at " + pick(["f ", "(", "a (b) ", ""]) + pick(["(", "(("]) + pick(["x.js", "", ":1"]) + ":" + pick(["1", "x"]) + ":" + pick(["2", ""]) + ")" + pick(["", "\n", "\u2028", " "]));
  agrees("surefire tally", testing(/Time elapsed:.*<<<[^\S\n]+(?:FAILURE|ERROR)!/), testing(FAILED_TALLY),
    () => pick(["", "Tests run: 1, ", "x"]) + "Time elapsed:" + pick([" 0.01 s ", "", "\u2028", "\n"]) + pick(["<<<", "<<", ""]) + gap() + pick(["FAILURE!", "ERROR!", "FAIL"]) + pick(["", " -- in T"]));
});

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
