// Mixed logs.
//
// A CI job runs a linter, then a typechecker, then the tests, and pastes all of it into
// one log. Only one extractor can own that output — so for a long time the other tools'
// failures were extracted, counted, and thrown away. An eslint-plus-jest log showed 2
// failures out of 92 and a line saying the other 90 existed somewhere, which left the
// reader doing exactly the work whatbroke is for.
//
// `failures` still means "what the winning tool reported" and is unchanged. Everything
// else arrives under `others`, attributed to the tool that produced it.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { analyse } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "bin", "whatbroke.js");
const fx = (n) => readFileSync(join(here, "fixtures", n), "utf8");

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
};

// Real captured logs, concatenated the way a CI job concatenates them.
const COMBOS = [
  ["eslint_fail.txt", "tsc_plain.txt", "vitest_fail.txt"],
  ["eslint_bulk_fail.txt", "jest_fail.txt"],
  ["ruff_fail.txt", "mypy_fail.txt", "pytest_fail.txt"],
  ["clang_fail.txt", "cargobuild_fail.txt"],
];
const joined = (parts) => parts.map(fx).join("\n");
const alone = (parts) => parts.reduce((n, f) => n + (analyse(fx(f))?.failures.length ?? 0), 0);
const recovered = (r) => r.failures.length + (r.others ?? []).reduce((n, o) => n + o.failures.length, 0);

// ------------------------------------------------------------------ recovery

test("every failure in a mixed log is recoverable", () => {
  for (const parts of COMBOS) {
    const r = analyse(joined(parts));
    assert.equal(recovered(r), alone(parts), `${parts.join(" + ")}: lost failures`);
  }
});

test("the winner's own failure list is unchanged", () => {
  // Anything reading `failures` must see exactly what it saw before.
  for (const parts of COMBOS) {
    const r = analyse(joined(parts));
    assert.ok(r.failures.length > 0);
    assert.ok(r.failures.length < recovered(r), "this combo should have had others to find");
    for (const f of r.failures) assert.ok(!("tool" in f) || f.tool === r.tool);
  }
});

test("each recovered failure says which tool found it", () => {
  const r = analyse(joined(COMBOS[0]));
  const tools = (r.others ?? []).map((o) => o.tool).sort();
  assert.deepEqual(tools, ["eslint", "tsc"]);
  for (const other of r.others) {
    assert.equal(other.count, other.failures.length, `${other.tool}: count disagrees with the list`);
    assert.ok(other.failures.length > 0);
  }
});

test("a recovered failure carries the same detail as when read alone", () => {
  const solo = analyse(fx("tsc_plain.txt"));
  const mixed = analyse(joined(COMBOS[0]));
  const tsc = mixed.others.find((o) => o.tool === "tsc");
  assert.equal(tsc.failures.length, solo.failures.length);
  for (const [i, f] of tsc.failures.entries()) {
    assert.equal(f.file, solo.failures[i].file);
    assert.equal(f.line, solo.failures[i].line);
    assert.equal(f.title, solo.failures[i].title);
    assert.equal(f.message, solo.failures[i].message);
  }
});

test("recovered failures are grouped by their own tool's vocabulary", () => {
  const r = analyse(joined(["eslint_bulk_fail.txt", "jest_fail.txt"]));
  const eslint = r.others.find((o) => o.tool === "eslint");
  assert.ok(Array.isArray(eslint.clusters), "others should be clustered too");
  const causes = eslint.clusters.filter((c) => c.reported);
  assert.ok(causes.length > 0, "90 eslint problems should yield at least one likely cause");
  const covered = eslint.clusters.reduce((n, c) => n + c.size, 0);
  assert.equal(covered, eslint.failures.length, "clusters must partition the failures");
});

test("--no-cluster leaves recovered failures ungrouped", () => {
  const r = analyse(joined(COMBOS[0]), { cluster: false });
  for (const other of r.others ?? []) assert.equal(other.clusters, null);
});

// ------------------------------------------------------------ no duplicates

test("one diagnosis is never reported under two tools", () => {
  // unittest prints its failures AS Python tracebacks. That is one failure read twice,
  // and it must not become two.
  const r = analyse(fx("py_unittest.txt"));
  assert.equal(r.tool, "unittest");
  assert.equal(r.others, undefined, "the traceback reading of the same failures leaked through");
});

test("no diagnostic appears twice across tools", () => {
  // A line can legitimately carry two problems - eslint reports eqeqeq and no-undef on
  // the same line - so the test is that no identical diagnostic repeats, not that a
  // location is used once.
  for (const parts of COMBOS) {
    const r = analyse(joined(parts));
    const exact = (f) => JSON.stringify([f.file, f.line, f.col, f.title, f.message]);
    const seen = new Set(r.failures.map(exact));
    for (const other of r.others ?? []) {
      for (const f of other.failures) {
        assert.ok(!seen.has(exact(f)), `${parts.join("+")}: ${f.file}:${f.line} ${f.title} reported twice`);
        seen.add(exact(f));
      }
    }
  }
});

test("two tools may both flag the same line for different reasons", () => {
  const r = analyse(joined(COMBOS[0]));
  const eslint = r.others.find((o) => o.tool === "eslint");
  const online3 = eslint.failures.filter((f) => f.line === 3);
  assert.equal(online3.length, 2, "eslint reports two distinct problems on that line");
  assert.notEqual(online3[0].title, online3[1].title);
});

// ------------------------------------------------- claims from a losing tool

test("a tool that does not own the log cannot contribute an unanchored failure", () => {
  // bun prints `error: expect(received).toEqual(expected)` and cargo's `^error:` claims
  // it, which is why bun asks to be registered ahead of cargo. Ordering settles who
  // WINS, but every other parser is still asked, so the same collision arrives here.
  const r = analyse(fx("bun_fail.txt") + "\n" + fx("cargobuild_fail.txt"));
  assert.equal(r.tool, "bun test");
  const cargo = r.others.find((o) => o.tool === "cargo");
  assert.equal(cargo.failures.length, analyse(fx("cargobuild_fail.txt")).failures.length,
    "cargo picked up bun's assertion text as a fourth compile error");
  for (const other of r.others) {
    for (const f of other.failures) {
      assert.ok(f.file || f.code || f.subject,
        `${other.tool} contributed a failure with no location and no identifier`);
    }
  }
});

test("a wrapper's stack is not a second tool's failures", () => {
  // esbuild's CLI wrapper crashes after esbuild exits non-zero; that stack lives
  // entirely in node internals and is the same failure told worse.
  const r = analyse(fx("esbuild_syntax_fail.txt"));
  assert.equal(r.tool, "esbuild");
  assert.equal(r.others, undefined);
});

test("a tool whose failures never carry a file is still reported", () => {
  // npm's failures have no file at all. Filtering the mixed-log path on location alone
  // would drop them silently, which is hiding a failure rather than showing a weak one.
  const r = analyse(fx("npm_fail.txt") + "\n" + fx("pytest_fail.txt"));
  const npm = (r.others ?? []).find((o) => o.tool === "npm");
  assert.ok(npm, "npm's failures vanished from the mixed log");
  assert.ok(npm.failures.length > 0);
});

test("one failure read twice is not two failures", () => {
  // A Python traceback ends `KeyError: 'taxrate'`, and node's parser recognises that
  // shape as an exception. The location test cannot catch it: the echo has no location.
  // What gives it away is that it says strictly less - its message sits inside the
  // other's, and it knows less about where the failure is.
  const r = analyse(fx("bun_fail.txt") + "\n" + fx("py_traceback.txt"));
  const python = r.others.find((o) => o.tool === "python");
  assert.ok(python, "the traceback's own reading should survive");
  assert.match(python.failures[0].message, /KeyError: 'taxrate'/);
  assert.equal(python.failures[0].file, "/home/dev/fx/boom.py");
  assert.ok(!r.others.some((o) => o.tool === "node"),
    "node's unlocated reading of the same line is the same failure told worse");
});

test("a diagnostic cannot borrow another tool's location", () => {
  // bun writes `error:` at line start and ruff writes `--> file:line:col`. cargo matches
  // the first and used to scan forward without limit for the second, producing a Rust
  // compile error at a Python file that nothing had reported.
  const r = analyse(fx("bun_fail.txt") + "\n" + fx("ruff_fail.txt"));
  for (const other of r.others ?? []) {
    for (const f of other.failures) {
      if (other.tool.startsWith("cargo")) {
        assert.fail(`cargo claimed ${f.file}: ${JSON.stringify(String(f.message).slice(0, 40))}`);
      }
    }
  }
});

test("logs that really do appear together are read exactly", () => {
  // The pair sweep concatenates arbitrary fixtures, including combinations no CI job
  // would ever produce. These are the ones that actually co-occur.
  const REAL = [
    ["eslint_fail.txt", "tsc_plain.txt", "vitest_fail.txt"],
    ["eslint_bulk_fail.txt", "jest_fail.txt"],
    ["ruff_fail.txt", "mypy_fail.txt", "pytest_fail.txt"],
    ["clang_fail.txt", "cargobuild_fail.txt"],
    ["eslint_fail.txt", "tsc_plain.txt", "jest_fail.txt", "npm_fail.txt"],
    ["ruff_fail.txt", "pytest_fail.txt", "pip_resolve_fail.txt"],
  ];
  for (const parts of REAL) {
    const r = analyse(joined(parts));
    assert.equal(recovered(r), alone(parts), `${parts.join(" + ")}`);
  }
});

test("a loose error pattern does not claim another tool's line", () => {
  // `error:` and `fatal:` at line start belong to half the tools in existence. git used
  // to report cargo's "error: could not compile ... due to 3 previous errors" - a tally
  // that cargo itself suppresses - and kubectl used to report deno's "error: Test
  // failed". Both are the collision the ordering protects the WINNER from, arriving
  // through the mixed-log path instead.
  for (const [a, b] of [["cargobuild_fail.txt", "git_conflict_fail.txt"],
    ["deno_fail.txt", "kubectl_noserver_fail.txt"]]) {
    const r = analyse(joined([a, b]));
    assert.equal(recovered(r), alone([a, b]), `${a} + ${b}`);
  }
});

test("git leads with what it actually found", () => {
  // When git has said something structural - a conflict, a rejected push - that is the
  // failure, and a loose `error:` line elsewhere in the log is not a second one.
  const r = analyse(joined(["cargobuild_fail.txt", "git_conflict_fail.txt"]));
  const git = r.others.find((o) => o.tool === "git");
  assert.equal(git.failures.length, 2, "the two conflicted files, and nothing else");
  assert.ok(git.failures.every((f) => f.label === "merge conflict"));
  assert.doesNotMatch(JSON.stringify(git.failures), /could not compile/);
});

// ------------------------------------------------------------------ output

test("a mixed log shows every tool in the terminal", () => {
  const r = spawnSync(process.execPath, [cli], {
    input: joined(COMBOS[0]), encoding: "utf8", env: { ...process.env, NO_COLOR: "1" },
  });
  assert.match(r.stdout, /eslint/, "eslint's section is missing");
  assert.match(r.stdout, /tsc/, "tsc's section is missing");
  assert.match(r.stdout, /TS2551/, "a recovered failure's detail is missing");
  assert.match(r.stdout, /no-unused-vars/);
});

test("every failure gets a GitHub annotation, whichever tool found it", () => {
  for (const parts of COMBOS) {
    const r = spawnSync(process.execPath, [cli, "--format", "github"], {
      input: joined(parts), encoding: "utf8", env: { ...process.env, GITHUB_STEP_SUMMARY: "" },
    });
    const errors = (r.stdout.match(/^::error /gm) ?? []).length;
    assert.equal(errors, alone(parts), `${parts.join(" + ")}: ${errors} annotations for ${alone(parts)} failures`);
  }
});

test("an annotation names the tool when it is not the one that owns the log", () => {
  const r = spawnSync(process.execPath, [cli, "--format", "github"], {
    input: joined(COMBOS[0]), encoding: "utf8", env: { ...process.env, GITHUB_STEP_SUMMARY: "" },
  });
  assert.match(r.stdout, /title=eslint no-unused-vars::/);
  assert.match(r.stdout, /title=tsc TS2551::/);
  // the winner's own failures stay unqualified
  assert.match(r.stdout, /title=invoice total::/);
});

test("a single-tool log gains nothing and loses nothing", () => {
  for (const name of ["pytest_fail.txt", "jest_fail.txt", "cargobuild_fail.txt"]) {
    const r = analyse(fx(name));
    assert.equal(r.others, undefined, `${name} grew an others list it should not have`);
  }
});

// ------------------------------------------- a pair never invents a failure

// Two logs concatenated cannot contain more failures than the two contain apart. When
// they do, some parser matched a line it does not own - and every one of those found so
// far was the same shape of mistake: a word that half the tools in existence write at
// line start ("error:", "Error:", "FAIL", "file:line:col:"), matched with nothing behind
// it to say whose it was.
//
// These six are the exact pairs that were wrong, each named by the parser that was
// over-claiming and the line it took. They are listed individually rather than left to
// the sweep below so a regression says which parser broke.
const OVERCLAIMS = [
  // node scanned the whole log for stack frames, so Go's expected-error string
  // "Error: if any flags in the group ..." adopted bun's frames.
  ["node",   "bun_fail.txt",             "gotest_cluster_fail.txt"],
  // git's bare `error:`/`fatal:` fallback took cargo's toplevel error.
  ["git",    "cargo_buildscript_fail.txt", "git_norepo_fail.txt"],
  // cargo pushed a compile error for any `error:` line, with no code and no location.
  ["cargo",  "cargo_manifest_fail.txt",  "git_overwrite_fail.txt"],
  // "file:line:col: message" is every compiler's shape, not Gradle's; clang's `note:`
  // lines came through as JVM compile errors under all three JVM tool names.
  ["jvm",    "clang_bulk_fail.txt",      "javac_fail.txt"],
  ["gradle", "clang_bulk_fail.txt",      "gradle_fail.txt"],
  ["maven",  "clang_bulk_fail.txt",      "maven_fail.txt"],
  // pnpm's error-code pattern matched any indented uppercase word, which is vitest's
  // " FAIL  src/x.spec.ts > name".
  ["pnpm",   "pnpm_lifecycle_fail.txt",  "vitest_cluster_fail.txt"],
  // python's traceback ran to the end of the log, so the exception line came from
  // whatever printed next - deno's "error: Test failed" is shaped like one.
  ["python", "py_traceback.txt",         "deno_fail.txt"],
];

test("a pair of logs never yields more failures than the two apart", () => {
  const bad = [];
  for (const [who, a, b] of OVERCLAIMS) {
    const apart = alone([a, b]);
    const together = recovered(analyse(fx(a) + "\n" + fx(b)));
    if (together > apart) bad.push(`${who}: ${a} + ${b} gave ${together}, the parts give ${apart}`);
  }
  assert.deepEqual(bad, [], "a parser claimed lines belonging to the other tool");
});

// The named cases above are the ones already understood. This sweep is how the next one
// gets found: every ordered pair of fixtures, counted the same way. It is a ratchet -
// the number may fall, and lowering the ceiling with it is part of the fix. It may not
// rise. Raising it means a change made whatbroke claim more than it can see, and the
// right response is to explain the new pairs, not to edit this number.
const CEILING = 19;

test("no more pairs over-claim than the last time this was measured", () => {
  const names = readdirSync(join(here, "fixtures"));
  const solo = new Map();
  for (const n of names) {
    try { solo.set(n, analyse(fx(n))); } catch { solo.set(n, null); }
  }
  const over = [];
  for (const a of names) {
    if (!solo.get(a)) continue;
    for (const b of names) {
      if (a === b || !solo.get(b)) continue;
      const apart = solo.get(a).failures.length + solo.get(b).failures.length;
      let r;
      try { r = analyse(fx(a) + "\n" + fx(b)); } catch { continue; }
      if (recovered(r) > apart) over.push(`${a} + ${b}`);
    }
  }
  assert.ok(over.length <= CEILING,
    `${over.length} pairs over-claim, ceiling is ${CEILING}:\n       ` + over.slice(0, 6).join("\n       "));
  if (over.length < CEILING) console.log(`       ${over.length} of ${names.length * (names.length - 1)} pairs over-claim (ceiling ${CEILING} - lower it)`);
});

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
