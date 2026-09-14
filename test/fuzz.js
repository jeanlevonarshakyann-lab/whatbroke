// Mutated real logs.
//
// "Never crash just because the input log is weird" is easy to assert against junk
// nobody would ever pipe in. The interesting inputs are the ones that are *almost*
// right: a real log cut in half, a line duplicated, a stray escape byte in the middle
// of a diagnostic, a file that lost its newlines. Those are what a truncated capture,
// an interleaved pipe, or a half-flushed CI buffer actually produces.
//
// The generator is seeded, so a failure here is reproducible rather than a story about
// a run that happened once.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import { analyse, EXTRACTORS } from "../src/index.js";
import { stripAnsi, stripCiPrefix } from "../src/util.js";
import { SOURCE_RANGE } from "../src/ownership.js";
import { createReport } from "../src/report.js";
import { REPORT_SCHEMA, inconsistencies, validate } from "./schema.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "fixtures");

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

const SEED = 12345;
let seed = SEED;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = (a) => a[Math.floor(rnd() * a.length)];

// Bytes a real log can carry that a parser has no reason to expect: a lone escape, a
// replacement character, a bare CR, a NUL, a thin space, a half-written colour code.
const JUNK = ["", "�", "\r", "\u0000", " ", " ", "\\", "]]", "[31m"];

const MUTATIONS = {
  truncate: (t) => t.slice(0, Math.floor(rnd() * t.length)),
  cutMiddle: (t) => {
    const l = t.split("\n"); const i = Math.floor(rnd() * l.length);
    return [...l.slice(0, i), ...l.slice(i + Math.floor(rnd() * 5))].join("\n");
  },
  duplicateLine: (t) => {
    const l = t.split("\n"); const i = Math.floor(rnd() * l.length);
    return [...l.slice(0, i), l[i], l[i], ...l.slice(i)].join("\n");
  },
  junkByte: (t) => { const i = Math.floor(rnd() * t.length); return t.slice(0, i) + pick(JUNK) + t.slice(i); },
  reverseLines: (t) => t.split("\n").reverse().join("\n"),
  dropNewlines: (t) => t.replace(/\n/g, () => (rnd() < 0.5 ? "" : "\n")),
  stripIndentation: (t) => t.replace(/[ \t]/g, ""),
  repeatHead: (t) => t + t.slice(0, Math.floor(t.length / 3)),
};

const ROUNDS = 12;   // every round runs every parser over every fixture
const SLOW_MS = 1500;

// analyse() wraps every extractor in a try/catch, so it cannot throw whatever a parser
// does. Testing through it would assert something true by construction - the first
// version of this file did exactly that, and an injected crash sailed through. The
// parsers are called directly so a throw is visible; analyse's catch is a safety net,
// not a reason for a parser to be allowed to fall over on a realistic log.
const normalise = (raw) => stripCiPrefix(stripAnsi(raw).replace(/\r\n?/g, "\n"));

test("a mutated real log never crashes or stalls a parser", () => {
  seed = SEED;
  const files = readdirSync(fixtures);
  const crashes = [];
  const slow = [];
  let runs = 0;

  for (let round = 0; round < ROUNDS; round++) {
    for (const f of files) {
      let text = readFileSync(join(fixtures, f), "utf8");
      const applied = [];
      for (let k = 0; k < 1 + Math.floor(rnd() * 3); k++) {
        const name = pick(Object.keys(MUTATIONS));
        applied.push(name);
        text = MUTATIONS[name](text);
      }
      runs++;
      const started = Date.now();
      const s = normalise(text);
      for (const ex of EXTRACTORS) {
        try { if (ex.detect(s)) ex.extract(s); }
        catch (e) { crashes.push(`${ex.name} on ${f} after ${applied.join("+")}: ${e.message}`); }
      }
      // and the whole pipeline, which adds normalisation, clustering and mixed logs
      try { analyse(text); }
      catch (e) { crashes.push(`analyse on ${f} after ${applied.join("+")}: ${e.message}`); }
      const took = Date.now() - started;
      if (took > SLOW_MS) slow.push(`${f} after ${applied.join("+")}: ${took}ms`);
    }
  }

  assert.ok(runs > 500, `only ${runs} mutations exercised`);
  assert.deepEqual(crashes, [], "a mutated log threw");
  assert.deepEqual(slow, [], `a mutated log took longer than ${SLOW_MS}ms`);
  console.log(`       ${runs} mutations x ${EXTRACTORS.length} parsers = ${runs * EXTRACTORS.length} calls, seed ${SEED}`);
});

// Every parser says which lines it read each failure from, and the reader believes it: two
// tools' readings of the same lines are one diagnosis. A range is only checked on the logs
// in the corpus, and a parser's code for a damaged log is exactly where one could go
// missing or point past the end of the log - bun's read back from a banner that a log out
// of order had put below the failure, and deno's ran past a JUnit document cut off before
// its closing tag.
test("every failure read from a mutated log says where it came from, inside the log", () => {
  seed = SEED + 2;
  const files = readdirSync(fixtures);
  const wrong = [];
  let read = 0;
  // Random mutations, and every fixture cut off a quarter, a half and three quarters of
  // the way through - a capture that stopped is the commonest damage, and the one that
  // leaves a report without its closing tag.
  const logs = [];
  for (let round = 0; round < 6; round++) {
    for (const f of files) {
      let text = readFileSync(join(fixtures, f), "utf8");
      const applied = [];
      for (let k = 0; k < 1 + Math.floor(rnd() * 3); k++) {
        const name = pick(Object.keys(MUTATIONS));
        applied.push(name);
        text = MUTATIONS[name](text);
      }
      logs.push({ f, applied, text });
    }
  }
  for (const f of files) {
    const all = readFileSync(join(fixtures, f), "utf8").split("\n");
    for (const part of [0.25, 0.5, 0.75]) {
      logs.push({ f, applied: [`cut at ${part}`], text: all.slice(0, Math.floor(all.length * part)).join("\n") });
    }
  }
  for (const { f, applied, text } of logs) {
    const s = normalise(text);
    const count = s.split("\n").length;
    for (const ex of EXTRACTORS) {
      let r = null;
      try { if (ex.detect(s)) r = ex.extract(s); } catch { continue; }
      for (const failure of r?.failures ?? []) {
        read++;
        const range = Object.getOwnPropertyDescriptor(failure, SOURCE_RANGE)?.value;
        const places = range ? [range, ...(range.also ?? [])] : [];
        const inside = places.length > 0 && places.every((p) => Number.isInteger(p.start) &&
          Number.isInteger(p.end) && p.start >= 0 && p.start < p.end && p.end <= count);
        if (!inside) wrong.push(`${ex.name} on ${f} after ${applied.join("+")}: ${JSON.stringify(range)} of ${count} lines`);
      }
    }
  }
  assert.ok(read > 5000, `only ${read} failures read`);
  assert.deepEqual(wrong.slice(0, 6), [], `${wrong.length} failures had no range, or one outside the log`);
});

// The corpus shows what a parser writes for the logs it was built from. A damaged log is
// where one writes something else - a column read from half a line, a severity marker cut
// away from its diagnostic - so the report built from each has to keep to the schema and
// to itself as well. Reading a warning as a failure is one of the things that checks.
test("a report read from a mutated log keeps to the schema, and never calls a warning a failure", () => {
  seed = SEED + 1;
  const files = readdirSync(fixtures);
  const wrong = [];
  let reports = 0;
  for (let round = 0; round < 10; round++) {
    for (const f of files) {
      let text = readFileSync(join(fixtures, f), "utf8");
      const name = pick(Object.keys(MUTATIONS));
      text = MUTATIONS[name](text);
      let r;
      try { r = analyse(text); } catch { continue; }
      if (r) reports++;
      const report = JSON.parse(JSON.stringify(createReport({ analysis: r, raw: text, exitCode: 0, inputMode: "pipe" })));
      for (const problem of [...validate(report, REPORT_SCHEMA, { strict: true }), ...inconsistencies(report)]) {
        wrong.push(`${f} after ${name}: ${problem}`);
      }
      // and evidence is lines of the log it was read from, not past its end
      const lines = text.split("\n").length;
      for (const failure of [...report.failures, ...(report.others ?? []).flatMap((o) => o.failures)]) {
        if (failure.evidence.some(({ end }) => end > lines)) wrong.push(`${f} after ${name}: ${JSON.stringify(failure.evidence)} of ${lines} lines`);
      }
    }
  }
  assert.ok(reports > 3000, `only ${reports} reports read`);
  assert.deepEqual(wrong.slice(0, 6), [], `${wrong.length} problems`);
});

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
