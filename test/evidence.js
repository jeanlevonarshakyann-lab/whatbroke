// Where each failure was read from.
//
// When a log holds two tools, whatbroke decides that two readings are one diagnosis when
// they came from the same lines. A parser that says which lines it read a failure from
// makes that a fact; for the ones that do not say yet, src/ownership.js guesses, by
// scoring every line of the log against the failure. The guess has been wrong in ways
// that cost a failure, and it is most of the time a log with many tools in it takes.
//
// So every range a parser writes down is held to the text it points at, and the parsers
// still guessing are listed by name. The list can only shrink: a parser that starts
// writing ranges has to come off it, and one that stops cannot quietly go back on.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EXTRACTORS } from "../src/index.js";
import { alsoFrom, joinSources, rangesOverlap, SOURCE_RANGE, sourceRange, withSource } from "../src/ownership.js";
import { jsonDocumentsAt, parsePlaced, stripAnsi } from "../src/util.js";

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

// The parsers whose failures still carry a guessed range on at least one fixture.
const GUESSING = new Set([]);

// Every parser that claims every fixture, on the text the way analyse hands it over.
const readings = [];
for (const name of readdirSync(join(here, "fixtures")).sort()) {
  const text = stripAnsi(readFileSync(join(here, "fixtures", name), "utf8").replace(/^﻿/, "").replace(/\r\n?/g, "\n"));
  for (const parser of EXTRACTORS) {
    let result = null;
    try { if (parser.detect(text)) result = parser.extract(text); } catch { result = null; }
    for (const failure of result?.failures ?? []) readings.push({ name, text, parser: parser.name, failure });
  }
}

// What a range has to hold to be about its failure: the file's name, the code, the name of
// the test, or the start or end of a line of the message - as written, or as JSON or XML
// would have escaped it. A test's result line often says nothing but its name, and a line
// said twice can differ in front: PHP writes a fatal to its error log as `PHP Parse
// error:  ...` and to stdout as `Parse error: ...`.
function evidenced(failure, lines, { start, end }) {
  const said = lines.slice(start, end).join("\n").replace(/[^\S\n]+/g, " ");
  const forms = (value) => {
    const v = String(value);
    return [v, JSON.stringify(v).slice(1, -1),
      v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;"),
      v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")];
  };
  const holds = (value) => !!value && forms(value).some((form) => said.includes(form));
  const base = failure.file ? String(failure.file).split(/[\\/]/).pop() : null;
  // A place can hold a later line of the message rather than its first: go's test prints
  // each of its messages on a line of its own, and parallel tests interleave them.
  const messageLines = String(failure.message ?? "").split("\n").map((l) => l.trim().replace(/[^\S\n]+/g, " "));
  const starts = messageLines.flatMap((l) => [l.slice(0, 16), l.slice(-16)]).filter((l) => l.length >= 6);
  const names = [failure.subject, failure.title].map((v) => String(v ?? "").trim()).filter((v) => v.length >= 4);
  // A message too short to search for - the generic reader's `FAIL` - has to be a whole
  // line of the range.
  const whole = String(failure.message ?? "").split("\n").map((l) => l.trim()).filter((l) => l && l.length < 6);
  const lineIs = (text) => lines.slice(start, end).some((l) => l.trim() === text);
  return holds(base) || holds(failure.code) || starts.some(holds) || names.some(holds) || whole.some(lineIs);
}

console.log("\nwhere failures were read from");

test("every range a parser writes down holds the failure it describes", () => {
  const wrong = [];
  let written = 0;
  for (const { name, text, parser, failure } of readings) {
    const own = Object.getOwnPropertyDescriptor(failure, SOURCE_RANGE);
    if (!own) continue;
    written++;
    const lines = text.split("\n");
    // Every place a failure was read from, when one parser read it in more than one.
    for (const range of own.value ? [own.value, ...(own.value.also ?? [])] : [own.value]) {
      if (!range || !Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < 0 ||
          range.end <= range.start || range.end > lines.length) {
        wrong.push(`${parser} on ${name}: range ${JSON.stringify(range)} for a ${lines.length}-line log`);
        continue;
      }
      if (!evidenced(failure, lines, range)) {
        wrong.push(`${parser} on ${name}: lines ${range.start}-${range.end} say nothing of ${JSON.stringify([failure.file, failure.code, failure.message])}`);
      }
    }
  }
  assert.deepEqual(wrong.slice(0, 10), []);
  assert.ok(written > 0, "no parser wrote a range, which tests nothing");
});

test("only the parsers listed as guessing leave the guessing to ownership", () => {
  const guessed = new Set(readings.filter((r) => !Object.getOwnPropertyDescriptor(r.failure, SOURCE_RANGE)).map((r) => r.parser));
  const unlisted = [...guessed].filter((p) => !GUESSING.has(p)).sort();
  const stale = [...GUESSING].filter((p) => !guessed.has(p)).sort();
  assert.deepEqual(unlisted, [], "these parsers guess and are not listed - write their ranges down");
  assert.deepEqual(stale, [], "these parsers no longer guess - take them off the list");
});

// A finding one parser keeps once, having read it twice - ruff's full form and its concise
// line, one run printed both ways - keeps both places. Otherwise the place it was not kept
// for belongs to nobody, and flake8, reading that concise line too, reported it again.
test("a finding read in two places keeps both, and overlaps a reading of either", () => {
  const table = withSource({ file: "a.py", line: 1, code: "F401", message: "`os` imported but unused" }, 7, 9);
  const line = withSource({ file: "a.py", line: 1, code: "F401", message: "`os` imported but unused" }, 0, 1);
  const kept = joinSources(table, line);
  assert.deepEqual(sourceRange(kept), { start: 0, end: 1, also: [{ start: 7, end: 9 }] });
  assert.equal(sourceRange(table).also, undefined, "the reading it was joined from is left as it was");
  for (const [start, end, overlaps, what] of [[0, 1, true, "the concise line"], [8, 9, true, "the table"], [3, 7, false, "neither"]]) {
    const reading = withSource({}, start, end);
    assert.equal(rangesOverlap(kept, reading), overlaps, `a reading of ${what}`);
    assert.equal(rangesOverlap(reading, kept), overlaps, `a reading of ${what}, asked the other way round`);
  }
  assert.equal(joinSources(kept, line), kept, "a place it already has is not added again");
});

test("a guess is not joined, and one finding keeps at most eight places", () => {
  const guessed = {};
  Object.defineProperty(guessed, SOURCE_RANGE, { get: () => ({ start: 3, end: 4 }), enumerable: false });
  const written = withSource({}, 0, 1);
  assert.equal(joinSources(written, guessed), written);
  assert.equal(joinSources(guessed, written), guessed);
  let many = withSource({}, 0, 1);
  for (let i = 1; i < 1000; i++) many = joinSources(many, withSource({}, 2 * i, 2 * i + 1));
  assert.equal(1 + sourceRange(many).also.length, 8);
});

test("places that touch are one place", () => {
  // A test's result line and the message lines under it, read one at a time.
  let failure = withSource({}, 52, 53);
  for (const line of [53, 54]) failure = alsoFrom(failure, line, line + 1);
  assert.deepEqual(sourceRange(failure), { start: 52, end: 55 });
  // ...and a place inside one already kept adds nothing.
  assert.equal(alsoFrom(failure, 53, 54), failure);
  // Apart, they stay apart, earliest first.
  assert.deepEqual(sourceRange(alsoFrom(failure, 10, 12)), { start: 10, end: 12, also: [{ start: 52, end: 55 }] });
});

// A report pretty-printed over hundreds of lines says where each finding is only through
// where its object is, and JSON.parse keeps no positions. parsePlaced reads the text again
// and has to build exactly what JSON.parse builds, or a parser reading through it would
// read a different report.
test("a document read with its places is the document JSON.parse reads", () => {
  const same = (x, y) => {
    const stack = [[x, y]];
    while (stack.length) {
      const [a, b] = stack.pop();
      if (typeof a !== typeof b) return false;
      if (a === null || typeof a !== "object") { if (!Object.is(a, b)) return false; continue; }
      if (Array.isArray(a) !== Array.isArray(b) || Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
      const ka = Reflect.ownKeys(a), kb = Reflect.ownKeys(b);
      if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
      for (const k of ka) stack.push([a[k], b[k]]);
    }
    return true;
  };
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const space = () => pick(["", "", " ", "\n", "\t", "\r\n", "  \n    "]);
  // Keys V8 orders by number, a repeated key, `__proto__`, and strings holding escapes and
  // the brackets and quotes a scan could mistake for structure.
  const KEYS = ["a", "b", "__proto__", "1", "0", "10", "-1", "constructor", "", "é", "\\u0041", "a\\\"b", "\\ud800", "x"];
  const STRINGS = ["", "x", "\\\"", "\\\\", "\\n", "\\u2028", "\\ud83d\\ude00", "\\ud800", "{", "}", "[", "]", ",", ":", "\\/", "1e5"];
  const NUMBERS = ["0", "-0", "1", "-1", "1.5", "1e3", "1E-3", "-0.0", "123456789012345678901234567890", "5e-324", "2e+2"];
  const value = (depth) => {
    const r = rnd();
    if (depth > 6 || r < 0.35) {
      const p = rnd();
      return p < 0.3 ? `"${pick(STRINGS)}"` : p < 0.6 ? pick(NUMBERS) : pick(["true", "false", "null"]);
    }
    const n = Math.floor(rnd() * 5);
    if (r < 0.65) return `[${space()}${Array.from({ length: n }, () => `${space()}${value(depth + 1)}${space()}`).join(",")}${space()}]`;
    return `{${space()}${Array.from({ length: n }, () => `${space()}"${pick(KEYS)}"${space()}:${space()}${value(depth + 1)}${space()}`).join(",")}${space()}}`;
  };
  const sources = Array.from({ length: 20000 }, () => (rnd() < 0.5 ? `[${value(1)}]` : value(0)));
  sources.push("[".repeat(50000) + "]".repeat(50000), '{"a":'.repeat(20000) + "1" + "}".repeat(20000));
  let checked = 0;
  for (const source of sources) {
    let expected;
    try { expected = JSON.parse(source); } catch { continue; }
    if (expected === null || typeof expected !== "object") continue;
    checked++;
    const { value: got, places } = parsePlaced(source);
    assert.ok(same(expected, got), `read differently: ${source.slice(0, 200)}`);
    // Each object and array is placed on the brackets that open and close it.
    const stack = [got];
    while (stack.length) {
      const node = stack.pop();
      if (node === null || typeof node !== "object") continue;
      const [open, close] = places.get(node);
      assert.equal(source[open] + source[close], Array.isArray(node) ? "[]" : "{}");
      if (source.length < 2000) assert.ok(same(JSON.parse(source.slice(open, close + 1)), node), `misplaced in ${source}`);
      for (const k of Reflect.ownKeys(node)) stack.push(node[k]);
    }
  }
  assert.ok(checked > 15000, `only ${checked} documents compared`);
});

test("a finding in a pretty-printed report is placed on its own object's lines", () => {
  const text = ["npm run lint", "[", "  {", '    "code": "F401",', '    "message": "one"', "  },", "  {", '    "code": "E711",', '    "message": "two"', "  }", "]", "done"].join("\n");
  const [doc] = jsonDocumentsAt(text, Array.isArray);
  assert.deepEqual(doc.where(doc.value[0]), { start: 2, end: 6 });
  assert.deepEqual(doc.where(doc.value[1]), { start: 6, end: 10 });
  assert.deepEqual(doc.where(doc.value[1].message), { start: 1, end: 11 }, "a string is placed on the whole document");
});

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
