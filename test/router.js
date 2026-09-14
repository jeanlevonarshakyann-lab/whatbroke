// Which parsers are asked about a log.
//
// A parser names strings a log has to hold for it to read anything from it, and the reader
// does not ask a parser about a log that holds none of them - see src/router.js. That is
// only safe while every signal list is complete, and it is only worth anything while the
// reader reads every log the same way with the router as without it. This holds both: on
// the corpus, on the corpus inside every runner's prefix, on logs damaged the ways a
// capture is damaged, and on logs holding two tools.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyse, EXTRACTORS } from "../src/index.js";
import { wrapperCandidates } from "../src/normalize.js";
import { presentSignals } from "../src/router.js";
import { stripAnsi, stripCiPrefix } from "../src/util.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "fixtures");
const fx = (n) => readFileSync(join(fixtures, n), "utf8");

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

let seed = 20260914;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = (list) => list[Math.floor(rnd() * list.length)];
const JUNK = ["", String.fromCharCode(0xfffd), String.fromCharCode(13), String.fromCharCode(0), String.fromCharCode(0x2009), "\\", "]]", String.fromCharCode(27) + "[31m"];
const MUTATIONS = {
  truncate: (t) => t.slice(0, Math.floor(rnd() * t.length)),
  cutMiddle: (t) => { const l = t.split("\n"); const i = Math.floor(rnd() * l.length); return [...l.slice(0, i), ...l.slice(i + Math.floor(rnd() * 5))].join("\n"); },
  duplicateLine: (t) => { const l = t.split("\n"); const i = Math.floor(rnd() * l.length); return [...l.slice(0, i), l[i], l[i], ...l.slice(i)].join("\n"); },
  junkByte: (t) => { const i = Math.floor(rnd() * t.length); return t.slice(0, i) + pick(JUNK) + t.slice(i); },
  reverseLines: (t) => t.split("\n").reverse().join("\n"),
  dropNewlines: (t) => t.replace(/\n/g, () => (rnd() < 0.5 ? "" : "\n")),
  stripIndentation: (t) => t.replace(/[ \t]/g, ""),
  repeatHead: (t) => t + t.slice(0, Math.floor(t.length / 3)),
};
// What a monorepo runner, a pod and a BuildKit step each put in front of every line.
const WRAPPERS = {
  turborepo: (l) => `api:test: ${l}`,
  pnpm: (l) => `packages/api test$ ${l}`,
  kubectl: (l) => `pod/api-7d9 ${l}`,
  docker: (l, i) => `#12 ${(i * 0.137 + 0.1).toFixed(3)} ${l}`,
};
const wrap = (text, fn) => text.split("\n").map((l, i) => (l.trim() ? fn(l, i) : l)).join("\n");

const names = readdirSync(fixtures).sort();
const logs = [];
for (const name of names) {
  const text = fx(name);
  logs.push({ label: name, text });
  for (const [runner, fn] of Object.entries(WRAPPERS)) logs.push({ label: `${name} under ${runner}`, text: wrap(text, fn) });
  const lines = text.split("\n");
  for (const part of [0.25, 0.5, 0.75]) logs.push({ label: `${name} cut at ${part}`, text: lines.slice(0, Math.floor(lines.length * part)).join("\n") });
  let mutated = text;
  const applied = [];
  for (let k = 0; k < 1 + Math.floor(rnd() * 3); k++) { const m = pick(Object.keys(MUTATIONS)); applied.push(m); mutated = MUTATIONS[m](mutated); }
  logs.push({ label: `${name} after ${applied.join("+")}`, text: mutated });
}
for (let k = 0; k < 400; k++) {
  const a = pick(names), b = pick(names);
  logs.push({ label: `${a} + ${b}`, text: `${fx(a)}\n${fx(b)}` });
}

console.log("\nwhich parsers are asked");

test("a parser claims a log only when the log holds one of its signals", () => {
  const missed = [];
  let asked = 0;
  for (const { label, text } of logs) {
    const base = stripCiPrefix(stripAnsi(text)).replace(/\r\n?/g, "\n");
    // ...and every text the reader would strip a wrapper to get, which is what a parser
    // is asked about when one is peeled off.
    for (const candidate of [base, ...wrapperCandidates(base).map((c) => c.text)]) {
      for (const ex of EXTRACTORS) {
        if (!ex.signals) continue;
        let claims = false;
        try { claims = !!ex.detect(candidate); } catch { claims = false; }
        asked++;
        if (claims && !ex.signals.some((signal) => candidate.includes(signal))) missed.push(`${ex.name} on ${label}`);
      }
    }
  }
  assert.ok(asked > 100000, `only ${asked} questions asked`);
  assert.deepEqual([...new Set(missed)].slice(0, 8), [], "these parsers claimed a log holding none of their signals");
});

test("a signal a stripped log holds, the log as given holds too", () => {
  // The router reads the log once and trusts the answer for every wrapper stripped from it.
  const signals = [...new Set(EXTRACTORS.flatMap((ex) => ex.signals ?? []))];
  const wrong = [];
  for (const { label, text } of logs) {
    const base = stripCiPrefix(stripAnsi(text)).replace(/\r\n?/g, "\n");
    const present = presentSignals(base, signals);
    for (const candidate of wrapperCandidates(base)) {
      for (const signal of presentSignals(candidate.text, signals)) {
        if (!present.has(signal)) wrong.push(`${label}: ${JSON.stringify(signal)} after stripping ${JSON.stringify(candidate.wrapper)}`);
      }
    }
  }
  assert.deepEqual(wrong.slice(0, 8), []);
});

test("the router reads every log as asking every parser does", () => {
  const view = (r) => JSON.stringify(r && { tool: r.tool, summary: r.summary, failures: r.failures, wrappers: r.wrappers,
    others: (r.others ?? []).map((o) => ({ tool: o.tool, count: o.count, summary: o.summary, failures: o.failures })) });
  const changed = [];
  for (const { label, text } of logs) {
    if (view(analyse(text)) !== view(analyse(text, { route: false }))) changed.push(label);
  }
  assert.deepEqual(changed.slice(0, 8), [], `${changed.length} logs read differently with the router`);
});

test("every signal a log holds is found, however they overlap", () => {
  const signals = ["FAIL", "--- FAIL", "error:", "::error", "error", "at ", "Traceback (most recent call last):"];
  // `::error:` holds `::error`, `error:` and `error` all at once, starting in two places;
  // `--- FAIL` holds `FAIL` inside it.
  assert.deepEqual([...presentSignals("x ::error: --- FAIL", signals)].sort(), ["--- FAIL", "::error", "FAIL", "error", "error:"]);
  assert.deepEqual([...presentSignals("nothing to see", signals)], []);
  assert.deepEqual([...presentSignals("a\nat b", signals)], ["at "]);
});

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
