// Bare TAP - the version every harness emits when you ask for TAP and nothing more.
//
//   not ok 1 - invoice total
//   #   Failed test 'invoice total'
//   #   at shop.t line 5.
//   #          got: '1049'
//   #     expected: '1050'
//
// tap.js reads node-tap's TAP 14, which carries a YAML block with an `at:` map, and it
// requires both the version line and that block. Plain TAP has neither, so `mocha
// --reporter tap` produced nothing at all, and Perl's Test::More output was claimed by
// the perl parser - which read `#   at shop.t line 5.` as a die, and reported two
// failures whose entire message was "#".
//
// What bounds this parser is TAP's own plan. A `not ok` line on its own is a sentence
// several tools write; a plan - `1..3`, exactly once, naming how many tests there are -
// is TAP declaring the document's shape, and nothing else in the corpus prints one.
import { alsoFrom, withSource } from "../ownership.js";

const PLAN_RE = /^[^\S\n]*1\.\.(\d+)[^\S\n]*$/m;
const NOT_OK_RE = /^[^\S\n]*not ok(?:[^\S\n]+(\d+))?[^\S\n]*(?:-[^\S\n]*)?(.*?)[^\S\n]*$/;
const OK_RE = /^[^\S\n]*ok[^\S\n]+\d+\b/;
const PLAN_LINE_RE = /^[^\S\n]*1\.\.\d+[^\S\n]*$/;
// A YAML block belongs to a structured dialect - node-tap, `node --test`, Deno - and
// each of those has a parser that reads it properly. Leave those blocks alone.
const YAML_OPEN_RE = /^[^\S\n]*---[^\S\n]*$/;
// Test::More says where it failed in a comment, and the file has no extension to key on.
const AT_RE = /^[^\S\n]*#[^\S\n]*at[^\S\n]+(\S.*?)[^\S\n]+line[^\S\n]+(\d+)\.?[^\S\n]*$/;
const GOT_RE = /^[^\S\n]*#[^\S\n]*got:[^\S\n]*(.*?)[^\S\n]*$/;
const WANTED_RE = /^[^\S\n]*#[^\S\n]*expected:[^\S\n]*(.*?)[^\S\n]*$/;
// "# Looks like you failed 2 tests of 3." and mocha's "# tests 2" are the epilogue.
const EPILOGUE_RE = /^[^\S\n]*#[^\S\n]*(?:Looks like|tests?[^\S\n]+\d|pass[^\S\n]+\d|fail[^\S\n]+\d|skip)/i;
// Without a plan there is no count TAP guarantees - but Test::More prints its own on the
// way out: "# Looks like you failed 2 tests of 3." Counting only what said `ok` reports
// "0 passed" for a run where one test passed, which is a claim, and a false one.
const LOOKS_LIKE_RE = /^[^\S\n]*#[^\S\n]*Looks like you failed[^\S\n]+(\d+)[^\S\n]+tests?[^\S\n]+of[^\S\n]+(\d+)/im;
const FAILED_TEST_RE = /^[^\S\n]*#[^\S\n]*Failed test\b/i;
// `prove` prints the diagnostics BEFORE the TAP stream rather than under each result, so
// the block below them is empty and the comments are orphaned. They are not anonymous,
// though: Test::More names the test it is talking about, and that name is the same
// string the `not ok` line carries. Matching on it is the tool's own link between them.
const FAILED_NAMED_RE = /^[^\S\n]*#[^\S\n]*Failed test[^\S\n]*'(.+?)'/i;
// A block is TAP's: a comment, or a line indented under the result. `prove` follows the
// stream with "Dubious, test returned 2" at column zero, which belongs to no test.
const BLOCK_LINE_RE = /^(?:[^\S\n]*#|[^\S\n]+\S)/;
// A JS harness indents a stack under the failure instead: `at Context.<anonymous>
// (test_shop.cjs:4:12)`. Frames inside the runtime are never the reader's code.
const FRAME_RE = /^[^\S\n]*at[^\S\n]+(?:.*?\()?([^\s()]+?):(\d+):(\d+)\)?[^\S\n]*$/;
const INTERNAL_RE = /^node:|[\\/]node_modules[\\/]|^(?:internal|timers)[\\/]/;
// A result that opens a brace is a group's roll-up - vitest's nested TAP wraps a file's
// tests in one - and its members report themselves below it. tap.js skips the same thing
// by another name; counting it turns a file with one failing test into two failures.
const GROUP_RE = /\{[^\S\n]*$/;
// TAP directives and timings hang off the name: `not ok 1 - adds # time=10.42ms`.
const DIRECTIVE_RE = /[^\S\n]*#[^\S\n]*(?:time=|SKIP\b|TODO\b).*$/i;
const MAX_MESSAGE_LINES = 2;

export default {
  name: "tap-text",
  // Strings a log has to hold for this parser to read anything from it - see src/router.js.
  // "Failed test" is Test::More's, and is how a `prove` run with no -v is recognised at
  // all: prove consumes the TAP stream itself and passes only these diagnostics through.
  signals: ["not ok", "Failed test"],
  category: "test",
  commands: ["tap", "prove", "mocha", "tape"],

  detect(text) {
    const lines = text.split("\n");
    if (PLAN_RE.test(text) && lines.some((line, i) =>
      NOT_OK_RE.test(line) && !structured(lines, i) && !GROUP_RE.test(line))) return true;
    // Failing that: `prove` without -v, which is how it is nearly always run.
    // It consumes the TAP stream itself and prints only Test::More's diagnostics, so the
    // document TAP's plan bounds is not there to bound. What bounds it instead is the
    // diagnostics being complete - a named test that says where it failed, or what it
    // wanted - which is already what namedDiagnostics requires before it keeps one.
    //
    // A separate question from the one above, not an alternative to it: a log can hold a
    // structured TAP stream, which this parser leaves to the dialect parsers, and a prove
    // run whose diagnostics nothing else will read. Asking only one of the two dropped
    // the prove half of every such pair.
    //
    // What prove prints in the stream's place, `t.t (Wstat: 512 Tests: 2 Failed: 2)`,
    // names no test, no line and no expectation. That is what the fallback was reading.
    return namedDiagnostics(lines).length > 0;
  },

  extract(text) {
    const lines = text.split("\n");
    let planned = 0, passed = 0;
    for (const line of lines) if (OK_RE.test(line) && !NOT_OK_RE.test(line)) passed++;
    const plan = text.match(PLAN_RE);
    if (plan) planned = +plan[1];

    const named = namedDiagnostics(lines);
    // Each failure with the line it was read from, so leftovers below can be put back in
    // the order the log tells it rather than after everything else.
    const found = [];
    for (let i = 0; i < lines.length; i++) {
      const head = lines[i].match(NOT_OK_RE);
      if (!head || structured(lines, i) || GROUP_RE.test(lines[i])) continue;
      const name = (head[2] || "").replace(DIRECTIVE_RE, "").trim() ||
        (head[1] ? `test ${head[1]}` : "test");
      let file, col, at;
      const got = {}, body = [];
      // The result line, and its block down to the last line anything was read from.
      let end = i + 1;
      // The block is everything until TAP's next statement. A result line or the plan
      // ends it, which is what keeps one failure's diagnostic out of the next one's.
      for (let j = i + 1; j < lines.length; j++) {
        if (NOT_OK_RE.test(lines[j]) || OK_RE.test(lines[j]) || PLAN_LINE_RE.test(lines[j])) break;
        if (EPILOGUE_RE.test(lines[j])) break;
        if (lines[j].trim() && !BLOCK_LINE_RE.test(lines[j])) break;
        if (FAILED_TEST_RE.test(lines[j])) { end = j + 1; continue; }
        const where = lines[j].match(AT_RE);
        if (where) { file ??= where[1]; at ??= +where[2]; end = j + 1; continue; }
        const g = lines[j].match(GOT_RE);
        if (g) { got.found ??= g[1]; end = j + 1; continue; }
        const w = lines[j].match(WANTED_RE);
        if (w) { got.wanted ??= w[1]; end = j + 1; continue; }
        const frame = lines[j].match(FRAME_RE);
        if (frame) {
          if (!file && !INTERNAL_RE.test(frame[1])) { file = frame[1]; at = +frame[2]; col = +frame[3]; }
          end = j + 1;
          continue;
        }
        const t = lines[j].replace(/^[^\S\n]*#[^\S\n]?/, "").trim();
        if (t && body.length < MAX_MESSAGE_LINES) { body.push(t); end = j + 1; }
      }
      // Nothing under the result line - so if this test was named in a diagnostic
      // elsewhere in the log, that is where it said what went wrong.
      // Whatever this result's block covered has been read as part of it. Raw Test::More
      // prints the diagnostic directly under the `not ok` it belongs to, and without this
      // the leftover pass below would report every one of them a second time.
      for (const d of named) if (d.from >= i && d.from < end) d.used = true;
      const orphan = (!file && !body.length && got.wanted === undefined)
        ? named.find((d) => d.name === name && !d.used) : undefined;
      if (orphan) orphan.used = true;
      if (orphan) { file = orphan.file; at = orphan.line; got.found = orphan.found; got.wanted = orphan.wanted; }
      const failure = withSource({
        file, line: at, col,
        title: name, subject: name, severity: "error",
        message: got.wanted !== undefined && got.found !== undefined
          ? `expected ${got.wanted}, got ${got.found}`
          : (body.join("\n") || name),
      }, i, end);
      // An orphan's facts were read where its harness printed them, too.
      found.push({ at: i, failure: orphan ? alsoFrom(failure, orphan.from, orphan.to) : failure });
    }
    // A diagnostic no result line took is a failure in its own right. `prove` with no -v
    // has nothing but these - it consumes the TAP stream itself - and Test::More has
    // already said everything needed: which test, which file and line, and what it
    // wanted. Asking whether each one was consumed, rather than whether any result was
    // found at all, is what keeps this working in a log that holds two runs: a mocha
    // stream woven with a prove run has results, and prove's diagnostics still belong to
    // nothing in it.
    for (const d of named) {
      if (d.used) continue;
      found.push({ at: d.from, failure: withSource({
        file: d.file, line: d.line,
        title: d.name, subject: d.name, severity: "error",
        message: d.wanted !== undefined && d.found !== undefined
          ? `expected ${d.wanted}, got ${d.found}`
          : d.name,
      }, d.from, d.to) });
    }
    // In the order the log tells it. prove prints its diagnostics before the stream, so
    // a leftover can belong ahead of results that were read after it.
    found.sort((a, b) => a.at - b.at);
    const failures = found.map((f) => f.failure);
    if (!failures.length) return null;
    // TAP's plan is the only count it guarantees, so what passed is what it says minus
    // what failed - not a tally line, which bare TAP does not have to print.
    const tally = text.match(LOOKS_LIKE_RE);
    const ran = planned || (tally ? +tally[2] : passed + failures.length);
    return {
      tool: "tap",
      summary: `${failures.length} failed, ${Math.max(0, ran - failures.length)} passed`,
      failures,
    };
  },
};

/** Test::More's diagnostics, in the order it printed them, each naming the test it is
 *  about. A list and not a map keyed by that name: one log can hold the same suite twice,
 *  and two runs of a test called "invoice total" are two failures, not one. */
function namedDiagnostics(lines) {
  const named = [];
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i].match(FAILED_NAMED_RE);
    if (!head) continue;
    const found = { name: head[1], from: i, to: i + 1 };
    for (let j = i + 1; j < lines.length && j <= i + 6; j++) {
      if (FAILED_NAMED_RE.test(lines[j])) break;
      const where = lines[j].match(AT_RE);
      if (where) { found.file ??= where[1]; found.line ??= +where[2]; found.to = j + 1; continue; }
      const g = lines[j].match(GOT_RE);
      if (g) { found.found ??= g[1]; found.to = j + 1; continue; }
      const w = lines[j].match(WANTED_RE);
      if (w) { found.wanted ??= w[1]; found.to = j + 1; }
    }
    if (found.file || found.wanted !== undefined) named.push(found);
  }
  return named;
}

/** Does a YAML block hang off this result line? Then a dialect parser owns it. */
function structured(lines, i) {
  for (let j = i + 1; j < lines.length; j++) {
    if (!lines[j].trim()) continue;
    if (YAML_OPEN_RE.test(lines[j])) return true;
    // A line at column zero that is not TAP's is somebody else writing to the same log.
    // Stopping at it took a structured result for a bare one whenever such a line landed
    // between `not ok` and its `---`, and read stylelint's report as one empty failure.
    if (!BLOCK_LINE_RE.test(lines[j]) && !NOT_OK_RE.test(lines[j]) && !OK_RE.test(lines[j]) &&
      !PLAN_LINE_RE.test(lines[j])) continue;
    return false;
  }
  return false;
}
