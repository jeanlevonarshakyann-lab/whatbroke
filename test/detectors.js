// The detector collision matrix.
//
// whatbroke picks a parser by asking each one "is this yours?" in a fixed order and
// taking the first that answers yes AND finds something. That means a detector which
// wrongly claims another tool's log is harmless only for as long as its extractor
// happens to come back empty - an invisible condition that a future change to that
// extractor can quietly remove, at which point the wrong parser starts diagnosing the
// wrong tool and nothing fails.
//
// So this file records, for every fixture: who claims it, who wins, and - the number
// that actually matters - how many failures each LOSING claimant would have extracted.
// The snapshot beside it is the measurement. Adding a parser that reaches into an
// existing fixture breaks this suite immediately and loudly, which is the entire point.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import { EXTRACTORS, analyse } from "../src/index.js";
import { stripAnsi, stripCiPrefix } from "../src/util.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "fixtures");
const snapshotPath = join(here, "detector-matrix.json");

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
};

/** Exactly the text analyse() hands the detectors. Measuring anything else would be
 *  measuring a different program. */
const normalise = (raw) => stripCiPrefix(stripAnsi(raw).replace(/\r\n?/g, "\n"));

const safely = (fn, fallback) => { try { return fn(); } catch { return fallback; } };

/** Who claims this log, who wins it, and what the losers would have said.
 *
 *  The loser test compares EXTRACTORS, not names. An extractor's name and the `tool`
 *  it reports are different namespaces - `cargo` reports "cargo test", `jvm` reports
 *  "gradle" - and comparing across them flags the winner as a collision with itself,
 *  which buries the handful of real ones under a pile of noise. */
export function survey(raw) {
  const s = normalise(raw);
  const result = safely(() => analyse(raw), null);
  const claims = EXTRACTORS.filter((e) => safely(() => e.detect(s), false));
  // Mirror analyse(): first claimant that actually finds something owns the log.
  const winner = claims.find((e) => safely(() => e.extract(s)?.failures?.length ?? 0, 0) > 0) ?? null;
  const shadow = {};
  for (const ex of claims) {
    if (ex === winner) continue;
    const n = safely(() => ex.extract(s)?.failures?.length ?? 0, 0);
    if (n > 0) shadow[ex.name] = n;
  }
  return {
    winner: result?.tool ?? null,
    parser: winner?.name ?? null,
    failures: result?.failures.length ?? 0,
    claimants: claims.map((e) => e.name),
    shadow,
  };
}

const current = {};
for (const name of readdirSync(fixtures).sort()) current[name] = survey(readFileSync(join(fixtures, name), "utf8"));

if (process.argv.includes("--update")) {
  writeFileSync(snapshotPath, JSON.stringify(current, null, 2) + "\n");
  console.log(`  wrote ${snapshotPath} for ${Object.keys(current).length} fixtures`);
  process.exit(0);
}

const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));

test("every fixture is in the matrix", () => {
  const missing = Object.keys(current).filter((f) => !(f in snapshot));
  assert.deepEqual(missing, [], "a new fixture must be recorded: node test/detectors.js --update");
  const stale = Object.keys(snapshot).filter((f) => !(f in current));
  assert.deepEqual(stale, [], "the matrix names fixtures that no longer exist");
});

test("no fixture changed hands", () => {
  for (const [f, was] of Object.entries(snapshot)) {
    assert.equal(current[f].winner, was.winner, `${f} is now parsed by a different tool`);
    assert.equal(current[f].parser, was.parser, `${f} is now claimed by a different extractor`);
    assert.equal(current[f].failures, was.failures, `${f} yields a different number of failures`);
  }
});

test("no detector newly claims a log that is not its own", () => {
  for (const [f, was] of Object.entries(snapshot)) {
    const added = current[f].claimants.filter((c) => !was.claimants.includes(c));
    assert.deepEqual(added, [], `${f}: ${added.join(", ")} started claiming another tool's log`);
  }
});

// The dangerous case. A losing detector that extracts nothing is inert; one that
// extracts failures is a misdiagnosis waiting for the extractor order to shift.
test("no losing detector newly starts extracting failures", () => {
  for (const [f, was] of Object.entries(snapshot)) {
    for (const [name, n] of Object.entries(current[f].shadow)) {
      const before = was.shadow?.[name] ?? 0;
      assert.ok(n <= before,
        `${f}: ${name} does not own this log but would now extract ${n} failures (was ${before})`);
    }
  }
});

test("the winner is never the generic fallback for a fixture a real parser claims", () => {
  for (const [f, row] of Object.entries(current)) {
    if (row.winner !== "output") continue;
    const real = row.claimants.filter((c) => c !== "generic");
    assert.deepEqual(real, [], `${f} fell through to the generic parser despite ${real.join(", ")}`);
  }
});

// Parser metadata.
//
// Adding parser #24 should mean editing one file. Everything a parser needs to declare
// about itself now lives with it: what kind of tool it is, and which commands imply it.
const CATEGORIES = new Set(["test", "lint", "typecheck", "compile", "build", "runtime", "package", "unknown"]);

test("every parser declares what kind of tool it is", () => {
  for (const ex of EXTRACTORS) {
    assert.ok(CATEGORIES.has(ex.category), `${ex.name}: category ${JSON.stringify(ex.category)} is not one of the known kinds`);
    assert.ok(Array.isArray(ex.commands), `${ex.name}: no commands declared`);
    if (ex.name !== "generic") assert.ok(ex.commands.length > 0, `${ex.name}: declares no command that implies it`);
  }
});

test("every failure carries a category", () => {
  for (const name of readdirSync(fixtures)) {
    const r = safely(() => analyse(readFileSync(join(fixtures, name), "utf8")), null);
    for (const f of r?.failures ?? []) {
      assert.ok(CATEGORIES.has(f.category), `${name}: failure with category ${JSON.stringify(f.category)}`);
    }
  }
});

// The command is evidence no log line can contradict: someone typing `whatbroke vitest`
// is saying which tool is about to fail. It only reorders, so it can improve an
// ambiguous log without being able to damage an unambiguous one.
test("the command that was run breaks a tie between two parsers", () => {
  const both = readFileSync(join(fixtures, "jest_fail.txt"), "utf8") + "\n" +
               readFileSync(join(fixtures, "vitest_fail.txt"), "utf8");
  assert.equal(analyse(both).tool, "jest", "with no command, list order decides");
  assert.equal(analyse(both, { command: ["vitest"] }).tool, "vitest");
  assert.equal(analyse(both, { command: ["jest"] }).tool, "jest");
  // the tool's name is rarely the bare first argument
  assert.equal(analyse(both, { command: ["npx", "vitest", "run"] }).tool, "vitest");
  assert.equal(analyse(both, { command: ["./node_modules/.bin/vitest"] }).tool, "vitest");
});

test("naming the wrong tool cannot damage a clear log", () => {
  for (const name of readdirSync(fixtures)) {
    const raw = readFileSync(join(fixtures, name), "utf8");
    const plain = safely(() => analyse(raw), null);
    if (!plain) continue;
    for (const command of [["vitest"], ["eslint"], ["cargo", "test"], ["mvn", "verify"]]) {
      const hinted = safely(() => analyse(raw, { command }), null);
      assert.equal(hinted?.tool, plain.tool, `${name} changed hands when ${command[0]} was named`);
      assert.equal(hinted?.failures.length, plain.failures.length, `${name} lost failures when ${command[0]} was named`);
    }
  }
});

// Interleaving.
//
// stdout and stderr are separate pipes, so a second stream's lines land in the middle
// of a diagnostic block. Losing some detail there is unavoidable - the block really was
// cut in half. GAINING a failure is not: it means a parser matched a line belonging to
// something else, and every gained failure is a claim the log does not support. This
// sweep is what caught vite reporting `[INFO] progress 45%` as a build error, because
// a log level is bracketed exactly like a rollup diagnostic code.
const INTERLEAVED = ["npm warn deprecated foo@1.0.0", "Downloading package...", "[INFO] progress 45%", "> my-app@1.0.0 test"];

test("interleaved output never invents a failure", () => {
  const gained = [];
  const lost = [];
  let checked = 0;
  for (const name of readdirSync(fixtures)) {
    const raw = readFileSync(join(fixtures, name), "utf8");
    const base = safely(() => analyse(raw), null);
    if (!base) continue;
    const mixed = raw.split("\n")
      .flatMap((l, i) => (i % 7 === 3 ? [INTERLEAVED[i % INTERLEAVED.length], l] : [l]))
      .join("\n");
    checked++;
    let r;
    try { r = analyse(mixed); } catch (e) { gained.push(`${name} threw ${e.message}`); continue; }
    const n = r?.failures.length ?? 0;
    if (r && r.tool === base.tool && n > base.failures.length) {
      gained.push(`${name}: ${base.failures.length} -> ${n}`);
    } else if (n < base.failures.length) {
      lost.push(`${name}: ${base.failures.length} -> ${n}`);
    }
  }
  assert.ok(checked > 40, `only ${checked} fixtures exercised`);
  assert.deepEqual(gained, [], "a parser matched a line that was not its own");
  // Losing detail when a block is cut in half is honest degradation, but it should stay
  // rare enough to notice if it spreads.
  assert.ok(lost.length <= 3, `${lost.length} fixtures lost failures: ${lost.join("; ")}`);
});

// Runaway backtracking.
//
// `\s` matches a newline, so `/^\s+at /m` at a blank line consumes every remaining
// newline in the log and then walks all the way back looking for "at" - once per line.
// A log with a long run of blank or whitespace-only lines therefore costs quadratic
// time, and eight extractors used to spend five to seventeen seconds each on one.
// Nothing about that input is exotic: any log with a lot of vertical space hits it.
//
// The budget is deliberately loose. Fixed, these finish in single-digit milliseconds;
// broken, they took thousands. A slow CI machine cannot cross that gap.
const HOSTILE = {
  "blank lines": "\n".repeat(50000),
  "space-only lines": "   \n".repeat(50000),
  "tab-only lines": "\t\t\n".repeat(50000),
  "whitespace around a stack frame": "  \n\t\n   at \n".repeat(20000),
  "indented keyword lines": "   FAIL   \n".repeat(50000),
};
const PER_EXTRACTOR_BUDGET_MS = 2000;

test("no detector backtracks on whitespace-heavy logs", () => {
  const slow = [];
  for (const [shape, text] of Object.entries(HOSTILE)) {
    for (const ex of EXTRACTORS) {
      const started = Date.now();
      safely(() => { if (ex.detect(text)) ex.extract(text); }, null);
      const took = Date.now() - started;
      if (took > PER_EXTRACTOR_BUDGET_MS) slow.push(`${ex.name} took ${took}ms on ${shape}`);
    }
  }
  assert.deepEqual(slow, [], "quantified \\s in a line-anchored pattern scans across newlines");
});

test("a whitespace-heavy log is analysed promptly end to end", () => {
  for (const [shape, text] of Object.entries(HOSTILE)) {
    const started = Date.now();
    safely(() => analyse(text), null);
    const took = Date.now() - started;
    assert.ok(took < PER_EXTRACTOR_BUDGET_MS, `analyse took ${took}ms on ${shape}`);
  }
});

const multi = Object.entries(current).filter(([, r]) => r.claimants.length > 2);
const shadowed = Object.entries(current).filter(([, r]) => Object.keys(r.shadow).length);
console.log(`\n  ${Object.keys(current).length} fixtures · ${multi.length} claimed by 3+ detectors · ${shadowed.length} with a losing detector that would extract`);
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
