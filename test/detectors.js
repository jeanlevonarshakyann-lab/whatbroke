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
      // `generic` is the exception, and inertly so. It is registered last, so it can
      // never take a log from a parser that recognises it, and `otherTools` skips it
      // outright - so it never contributes to a mixed log either. Its reach growing is
      // the fallback getting better at the long tail, not a collision. Still recorded
      // in the snapshot, just not a failure.
      if (name === "generic") continue;
      const before = was.shadow?.[name] ?? 0;
      assert.ok(n <= before,
        `${f}: ${name} does not own this log but would now extract ${n} failures (was ${before})`);
    }
  }
});

test("the winner is never the generic fallback for a fixture a real parser can read", () => {
  for (const [f, row] of Object.entries(current)) {
    if (row.winner !== "output") continue;
    // Claiming is not reading. bun writes `error:` in lower case over a stack that looks
    // like Node's, so node's detector fires and its extractor then finds nothing - which
    // is exactly the fall-through the ordering is designed to allow. What would be wrong
    // is a parser that could have EXTRACTED something losing to the guess.
    const able = Object.keys(row.shadow).filter((c) => c !== "generic");
    assert.deepEqual(able, [], `${f} fell through to the guess despite ${able.join(", ")} being able to read it`);
  }
});

// Parser metadata.
//
// Adding parser #24 should mean editing one file. Everything a parser needs to declare
// about itself now lives with it: what kind of tool it is, and which commands imply it.
const CATEGORIES = new Set(["test", "lint", "typecheck", "compile", "build", "runtime", "package", "vcs", "deploy", "unknown"]);

test("every parser declares what kind of tool it is", () => {
  for (const ex of EXTRACTORS) {
    assert.ok(CATEGORIES.has(ex.category), `${ex.name}: category ${JSON.stringify(ex.category)} is not one of the known kinds`);
    // "unknown" means the tool was not recognised, which is only ever true of the
    // fallback. kubectl sat here for a while - a known tool filed under not knowing.
    if (ex.category === "unknown") {
      assert.equal(ex.name, "generic", `${ex.name} is a known tool; "unknown" is the fallback's category`);
    }
    assert.ok(Array.isArray(ex.commands), `${ex.name}: no commands declared`);
    if (ex.commandHints !== undefined) {
      assert.ok(Array.isArray(ex.commandHints), `${ex.name}: commandHints must be an array`);
      assert.ok(ex.commandHints.every((command) => ex.commands.includes(command)),
        `${ex.name}: commandHints must be drawn from commands`);
    }
    if (ex.name !== "generic") assert.ok(ex.commands.length > 0, `${ex.name}: declares no command that implies it`);
  }
});

// The README's table is the tool's public claim about what it reads. It went stale
// silently: six parsers were added over one stretch of work and none of them appeared in
// it, so the published page under-sold the tool and, worse, could just as easily have
// over-sold it. A parser is listed under its own name or under one of the commands that
// implies it - the table says "GCC/Clang" and "javac / Maven / Gradle" where the parsers
// are called clang and jvm, which is right for a reader and wrong for a substring match.
// A parser with no fixture of its own is code nothing runs. Injecting a throw into each
// of the 40 extract() functions in turn and running the whole suite showed that every one
// of them is currently caught - which is the strong form of this check, and takes ten
// minutes. This is the fast proxy: the matrix records the winning PARSER for every
// fixture, so a parser absent from that column owns nothing.
test("every parser owns at least one fixture", () => {
  const owned = new Set(Object.values(snapshot).map((row) => row.parser));
  const orphans = EXTRACTORS.map((ex) => ex.name).filter((n) => !owned.has(n));
  assert.deepEqual(orphans, [], "a parser wins no log in the corpus, so nothing exercises it");
});

test("every parser appears in the README's table", () => {
  const readme = readFileSync(join(fixtures, "..", "..", "README.md"), "utf8").toLowerCase();
  const rows = readme.split("\n").filter((l) => l.startsWith("| **"));
  assert.ok(rows.length > 30, `only ${rows.length} rows found; has the table moved?`);
  const table = rows.join("\n");
  const undocumented = [];
  for (const ex of EXTRACTORS) {
    if (ex.name === "generic") continue;   // the table's last row, worded as a catch-all
    const names = [ex.name, ...(ex.commands ?? [])].map((n) => n.toLowerCase());
    if (!names.some((n) => table.includes(`**${n}`) || table.includes(`${n}**`) || table.includes(`/ ${n} `) || table.includes(`${n} /`))) {
      undocumented.push(ex.name);
    }
  }
  assert.deepEqual(undocumented, [], "a parser reads a tool the README does not mention");
});

// Being mentioned is not the same as being described. The make row read "no parser of its
// own" for a while after make got one - the check above passed the whole time, because it
// looks for the name and the name was right there in the sentence denying it. A row that
// disclaims a parser the tool actually has is worse than no row: it is the README stating
// the opposite of the truth.
test("no README row denies a parser that exists", () => {
  const readme = readFileSync(join(fixtures, "..", "..", "README.md"), "utf8");
  const denied = [];
  for (const row of readme.split("\n").filter((l) => l.startsWith("| **"))) {
    if (!/no parser of its own/i.test(row)) continue;
    const subject = row.match(/^\|[^\S\n]*\*\*(.+?)\*\*/)?.[1]?.toLowerCase();
    if (!subject) continue;
    if (EXTRACTORS.some((ex) => ex.name.toLowerCase() === subject ||
        (ex.commands ?? []).some((c) => c.toLowerCase() === subject))) denied.push(subject);
  }
  assert.deepEqual(denied, [], "the README says a tool has no parser, and it has one");
});

// Fixtures are captured on a real machine and then given the corpus's neutral paths,
// /home/dev. That rewrite was done once for seven fixtures (#71) with nothing to keep it
// done, and nine more drifted in afterwards: a scratch directory naming the session that
// recorded it, and a home directory with the capturing user's name in it. A path is not
// a diagnostic, so rewriting one never changes what a log reads as - which is exactly
// why nothing else in the suite ever noticed.
const LEAKED_PATH = /\/private\/tmp\/|\/scratchpad\/|(?:^|[\s'"(=])\/Users\/[^/\s]+\//m;
test("no fixture carries the path of the machine it was captured on", () => {
  // The rule is the guard, so it is pinned too: loosening it later has to be deliberate.
  for (const leak of ["at /private/tmp/tmp.X1b2/app/y.js:1", "see /Users/jean/.npm/_logs/a.log",
    "command: /Users/x/.hermes/node/bin/node", "loadSuiteClassFile('/private/tmp/cl...')"]) {
    assert.ok(LEAKED_PATH.test(leak), `${JSON.stringify(leak)} names the capturing machine`);
  }
  // ...and the paths CI runners really print are not leaks. Windows writes C:\Users with
  // backslashes, and a runner's workspace is D:/a/<repo>.
  for (const fine of ["/home/dev/app/a.js:1:2", "C:\\Users\\runneradmin\\x.go:3",
    "D:/a/whatbroke/t/shop_test.go:13", "C:/hostedtoolcache/windows/go/src/testing/testing.go:1631"]) {
    assert.ok(!LEAKED_PATH.test(fine), `${JSON.stringify(fine)} is a path a tool really prints`);
  }
  const leaked = readdirSync(fixtures).filter((name) => LEAKED_PATH.test(readFileSync(join(fixtures, name), "utf8")));
  assert.deepEqual(leaked, [], "a fixture still names the machine it was captured on");
});

test("every failure carries a category", () => {
  for (const name of readdirSync(fixtures)) {
    const r = safely(() => analyse(readFileSync(join(fixtures, name), "utf8")), null);
    for (const f of r?.failures ?? []) {
      assert.ok(CATEGORIES.has(f.category), `${name}: failure with category ${JSON.stringify(f.category)}`);
    }
  }
});

// A leaf command is strong evidence: someone typing `whatbroke vitest` is saying which
// tool is about to fail. It only reorders, so it can improve an ambiguous log without
// being able to damage an unambiguous one.
test("the command that was run breaks a tie between two parsers", () => {
  const both = readFileSync(join(fixtures, "jest_fail.txt"), "utf8") + "\n" +
               readFileSync(join(fixtures, "vitest_fail.txt"), "utf8");
  assert.equal(analyse(both).tool, "jest", "with no command, list order decides");
  assert.equal(analyse(both, { command: ["vitest"] }).tool, "vitest");
  assert.equal(analyse(both, { command: ["jest"] }).tool, "jest");
  // the tool's name is rarely the bare first argument
  assert.equal(analyse(both, { command: ["npx", "vitest", "run"] }).tool, "vitest");
  assert.equal(analyse(both, { command: ["./node_modules/.bin/vitest"] }).tool, "vitest");
  assert.equal(analyse(both, { command: ["VITEST.CMD"] }).tool, "vitest",
    "Windows command names are case-insensitive");
  assert.equal(analyse(both, { command: ["vitest", "jest"] }).tool, "vitest",
    "a later tool-like argument cannot outrank the executable");
});

test("a launcher command cannot outrank the failure produced by its child", () => {
  const cases = [
    ["jest_fail.txt", "npm_fail.txt", ["npm", "test"], "jest", "npm"],
    ["vitest_fail.txt", "pnpm_script_fail.txt", ["pnpm", "test"], "vitest", "pnpm"],
    ["vite_resolve_fail.txt", "yarn_fail.txt", ["yarn", "build"], "vite", "yarn"],
    ["pytest_fail.txt", "pip_resolve_fail.txt", ["poetry", "run", "pytest"], "pytest", "pip"],
    ["pytest_fail.txt", "pip_resolve_fail.txt", ["uv", "run", "pytest"], "pytest", "pip"],
  ];
  for (const [child, launcher, command, wanted, secondary] of cases) {
    const raw = readFileSync(join(fixtures, child), "utf8") + "\n" +
      readFileSync(join(fixtures, launcher), "utf8");
    const result = analyse(raw, { command });
    assert.equal(result.tool, wanted, `${command.join(" ")} promoted the launcher over ${wanted}`);
    assert.ok(result.others.some((other) => other.tool === secondary),
      `${secondary}'s own diagnostic should still be retained`);
  }
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

// Whitespace is not always a space.
//
// pnpm indents every diagnostic with U+2009 THIN SPACE. A pattern written [ \t] matches
// none of it, so a parser using that class sees no indentation at all and reports
// nothing. This is the correctness half of the fix that stopped parsers backtracking
// across newlines: [^\S\n] is equally immune - it cannot cross a line either - and
// unlike [ \t] it still matches every kind of space a tool might print.
// Structured machine formats are the exception: replacing JSON's grammar whitespace,
// or changing bytes behind Swift's declared byte count, corrupts the serialization
// rather than re-indenting a diagnostic. Their decoded human output is exercised by
// the same mutation through the paired text fixtures.
const SERIALIZED_FIXTURES = new Set([
  "swiftc_parseable_fail.txt", "terraform_validate_json_fail.txt",
  // A pretty-printed JSON report is a document, not a stream of lines: splicing another
  // tool's output into the middle of one leaves something no parser can read, and that
  // is the format's nature rather than a parser being fragile.
  "ruff_json_fail.txt", "mocha_json_fail.txt",
]);

test("parsers match whitespace that is not an ASCII space", () => {
  const thin = (t) => t.split("\n").map((l) => l.replace(/^ +/, (m) => "\u2009".repeat(m.length))).join("\n");
  const broken = [];
  for (const name of readdirSync(fixtures)) {
    if (SERIALIZED_FIXTURES.has(name)) continue;
    const raw = readFileSync(join(fixtures, name), "utf8");
    const plain = safely(() => analyse(raw), null);
    if (!plain) continue;
    const indented = safely(() => analyse(thin(raw)), null);
    if (indented?.tool !== plain.tool || indented?.failures.length !== plain.failures.length) {
      broken.push(`${name}: ${plain.tool}/${plain.failures.length} -> ${indented?.tool}/${indented?.failures.length ?? 0}`);
    }
  }
  assert.deepEqual(broken, [], "re-indenting with a thin space changed the reading");
  // and the case that found this: pnpm's own output, indented that way for real
  const pnpm = analyse(readFileSync(join(fixtures, "pnpm_script_fail.txt"), "utf8"));
  assert.equal(pnpm?.tool, "pnpm");
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

// Losing detail and losing the document are not the same failure. A pretty-printed
// report - mocha's JSON, markdownlint's --json - is one value spread over many lines,
// so a line landing inside it does not cut a diagnostic in half, it makes the whole
// thing invalid and nothing can be read from it at all. That is a property of the
// format, not a weakness in the parser, so it is named here rather than spent from the
// budget below. The same run's text capture is in the corpus and takes the mutation.
const INTERLEAVING_DESTROYS = new Set([...SERIALIZED_FIXTURES,
  "mocha_json_fail.txt", "markdownlint_json_fail.txt",
]);

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
    } else if (n < base.failures.length && !INTERLEAVING_DESTROYS.has(name)) {
      lost.push(`${name}: ${base.failures.length} -> ${n}`);
    }
  }
  assert.ok(checked > 40, `only ${checked} fixtures exercised`);
  assert.deepEqual(gained, [], "a parser matched a line that was not its own");
  // Losing detail when a block is cut in half is honest degradation, but it should stay
  // rare enough to notice if it spreads.
  assert.ok(lost.length <= 2, `${lost.length} fixtures lost failures: ${lost.join("; ")}`);
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
