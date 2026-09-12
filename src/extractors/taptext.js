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
  category: "test",
  commands: ["tap", "prove", "mocha", "tape"],

  detect(text) {
    if (!PLAN_RE.test(text)) return false;
    const lines = text.split("\n");
    return lines.some((line, i) =>
      NOT_OK_RE.test(line) && !structured(lines, i) && !GROUP_RE.test(line));
  },

  extract(text) {
    const lines = text.split("\n");
    const failures = [];
    let planned = 0, passed = 0;
    for (const line of lines) if (OK_RE.test(line) && !NOT_OK_RE.test(line)) passed++;
    const plan = text.match(PLAN_RE);
    if (plan) planned = +plan[1];

    const named = namedDiagnostics(lines);
    for (let i = 0; i < lines.length; i++) {
      const head = lines[i].match(NOT_OK_RE);
      if (!head || structured(lines, i) || GROUP_RE.test(lines[i])) continue;
      const name = (head[2] || "").replace(DIRECTIVE_RE, "").trim() ||
        (head[1] ? `test ${head[1]}` : "test");
      let file, col, at;
      const got = {}, body = [];
      // The block is everything until TAP's next statement. A result line or the plan
      // ends it, which is what keeps one failure's diagnostic out of the next one's.
      for (let j = i + 1; j < lines.length; j++) {
        if (NOT_OK_RE.test(lines[j]) || OK_RE.test(lines[j]) || PLAN_LINE_RE.test(lines[j])) break;
        if (EPILOGUE_RE.test(lines[j])) break;
        if (lines[j].trim() && !BLOCK_LINE_RE.test(lines[j])) break;
        if (FAILED_TEST_RE.test(lines[j])) continue;
        const where = lines[j].match(AT_RE);
        if (where) { file ??= where[1]; at ??= +where[2]; continue; }
        const g = lines[j].match(GOT_RE);
        if (g) { got.found ??= g[1]; continue; }
        const w = lines[j].match(WANTED_RE);
        if (w) { got.wanted ??= w[1]; continue; }
        const frame = lines[j].match(FRAME_RE);
        if (frame) {
          if (!file && !INTERNAL_RE.test(frame[1])) { file = frame[1]; at = +frame[2]; col = +frame[3]; }
          continue;
        }
        const t = lines[j].replace(/^[^\S\n]*#[^\S\n]?/, "").trim();
        if (t && body.length < MAX_MESSAGE_LINES) body.push(t);
      }
      // Nothing under the result line - so if this test was named in a diagnostic
      // elsewhere in the log, that is where it said what went wrong.
      const orphan = (!file && !body.length && got.wanted === undefined) ? named.get(name) : undefined;
      if (orphan) { file = orphan.file; at = orphan.line; got.found = orphan.found; got.wanted = orphan.wanted; }
      failures.push({
        file, line: at, col,
        title: name, subject: name, severity: "error",
        message: got.wanted !== undefined && got.found !== undefined
          ? `expected ${got.wanted}, got ${got.found}`
          : (body.join("\n") || name),
      });
    }
    if (!failures.length) return null;
    // TAP's plan is the only count it guarantees, so what passed is what it says minus
    // what failed - not a tally line, which bare TAP does not have to print.
    const ran = planned || passed + failures.length;
    return {
      tool: "tap",
      summary: `${failures.length} failed, ${Math.max(0, ran - failures.length)} passed`,
      failures,
    };
  },
};

/** Test::More's diagnostics, keyed by the test name they are about. */
function namedDiagnostics(lines) {
  const named = new Map();
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i].match(FAILED_NAMED_RE);
    if (!head || named.has(head[1])) continue;
    const found = {};
    for (let j = i + 1; j < lines.length && j <= i + 6; j++) {
      if (FAILED_NAMED_RE.test(lines[j])) break;
      const where = lines[j].match(AT_RE);
      if (where) { found.file ??= where[1]; found.line ??= +where[2]; continue; }
      const g = lines[j].match(GOT_RE);
      if (g) { found.found ??= g[1]; continue; }
      const w = lines[j].match(WANTED_RE);
      if (w) { found.wanted ??= w[1]; }
    }
    if (found.file || found.wanted !== undefined) named.set(head[1], found);
  }
  return named;
}

/** Does a YAML block hang off this result line? Then a dialect parser owns it. */
function structured(lines, i) {
  for (let j = i + 1; j < lines.length; j++) {
    if (!lines[j].trim()) continue;
    return YAML_OPEN_RE.test(lines[j]);
  }
  return false;
}
