// Cross-run comparison makes claims about a run nobody can see any more, so the
// tests care less about "does it group" than about "when does it refuse to speak".
// A wrong "new" is noise; a wrong "no longer reported" tells you a bug is fixed when
// it is not, and that is the claim this module has to earn.
import { mkdtempSync, rmSync, readdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { compare, cacheDir, runIdentity } from "../src/history.js";
import { causeId } from "../src/cluster.js";
import { analyse } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "bin", "whatbroke.js");
const fx = (n) => readFileSync(join(here, "fixtures", n), "utf8");

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
};

const caches = [];
function cache() {
  const d = mkdtempSync(join(tmpdir(), "wb-hist-"));
  caches.push(d);
  return d;
}
const run = (store, input, args = []) => spawnSync(process.execPath, [cli, "--since-last", ...args], {
  input, encoding: "utf8",
  env: { ...process.env, NO_COLOR: "1", WHATBROKE_CACHE_DIR: store },
});
const stored = (store) => readdirSync(store).filter((f) => f.endsWith(".json"));

// ------------------------------------------------------------------ comparing

test("the first tracked run compares against nothing and says so", () => {
  const store = cache();
  const r = run(store, fx("pytest_fail.txt"));
  assert.match(r.stdout, /first tracked run/);
  assert.doesNotMatch(r.stdout, /\bnew\b since/, "there is nothing for it to be new against");
  assert.equal(stored(store).length, 1, "the run should have been recorded");
});

test("an identical second run reports nothing new", () => {
  const store = cache();
  run(store, fx("pytest_fail.txt"));
  const r = run(store, fx("pytest_fail.txt"));
  assert.match(r.stdout, /nothing new since your last run/);
  assert.doesNotMatch(r.stdout, /no longer reported/);
});

test("a changed cause is marked new, and the one it replaced is reported gone", () => {
  const store = cache();
  run(store, fx("pytest_fail.txt"));
  const r = run(store, fx("pytest_fail.txt").replace("KeyError: 'exp'", "KeyError: 'aud'"));
  assert.match(r.stdout, /1 new since your last run/);
  assert.match(r.stdout, /1 from that run is no longer reported/);
  // the marker has to sit on the cause that actually changed
  const marked = r.stdout.split("\n").filter((l) => /\bnew$/.test(l));
  assert.equal(marked.length, 1, `expected one marked cause, got ${marked.length}`);
  assert.match(marked[0], /test_expired_token/);
});

test("a cause that merely moves position is not called new", () => {
  const store = cache();
  run(store, fx("eslint_bulk_fail.txt"));
  // Same failures, fewer of them: nothing here is a NEW bug.
  const trimmed = fx("eslint_bulk_fail.txt").split("\n").filter((l, i) => i % 7 !== 3).join("\n");
  const r = run(store, trimmed);
  assert.doesNotMatch(r.stdout, /[1-9]\d* new since your last run/,
    "dropping failures must not manufacture new causes");
});

// ------------------------------------------------------------------- refusing

test("a truncated run never claims a cause is gone", () => {
  const previous = { causes: ["aaaa1111", "bbbb2222"], ranAt: "2026-01-01T00:00:00.000Z" };
  const partial = compare(previous, ["aaaa1111"], { truncated: true });
  assert.equal(partial.gone, null, "an incomplete capture is not evidence of a fix");
  assert.equal(partial.goneWithheld, "truncated");
  // presence is still safe to talk about
  assert.deepEqual(compare(previous, ["cccc3333"], { truncated: true }).fresh, ["cccc3333"]);
});

test("a run that could not be trusted is not recorded over a good one", () => {
  const store = cache();
  run(store, fx("pytest_fail.txt"));
  const before = readFileSync(join(store, stored(store)[0]), "utf8");
  run(store, fx("pytest_fail.txt"), ["--max-bytes", "1024"]);
  const after = readFileSync(join(store, stored(store)[0]), "utf8");
  assert.equal(before, after, "a truncated run overwrote the last good state");
});

test("a run with nothing parsed compares nothing and records nothing", () => {
  const store = cache();
  const r = run(store, "this is not any tool's output\n");
  assert.equal(stored(store).length, 0);
  assert.doesNotMatch(r.stdout, /since your last run/);
});

test("no previous run means no comparison, not an empty one", () => {
  const c = compare(null, ["aaaa1111"]);
  assert.equal(c.compared, false);
  assert.equal(c.reason, "no-previous-run");
  assert.deepEqual(c.fresh, [], "with nothing to compare against, nothing is 'new'");
});

// ------------------------------------------------------------------ identity

test("different commands never compare against each other", () => {
  const a = runIdentity({ cwd: "/p", tool: "pytest", argv: ["pytest", "tests/unit"] });
  const b = runIdentity({ cwd: "/p", tool: "pytest", argv: ["pytest", "tests/api"] });
  assert.notEqual(a, b, "two different test selections are not the same run");
});

test("different tools and different directories never compare against each other", () => {
  const base = { cwd: "/p", tool: "pytest", argv: [] };
  assert.notEqual(runIdentity(base), runIdentity({ ...base, tool: "jest" }));
  assert.notEqual(runIdentity(base), runIdentity({ ...base, cwd: "/other" }));
});

test("a second tool in the same directory starts its own history", () => {
  const store = cache();
  run(store, fx("pytest_fail.txt"));
  const r = run(store, fx("eslint_fail.txt"));
  assert.equal(stored(store).length, 2, "the two tools must not share one record");
  assert.match(r.stdout, /first tracked run/);
});

test("a cause id survives a rerun but separates two different bugs", () => {
  const one = analyse(fx("pytest_fail.txt"));
  const two = analyse(fx("pytest_fail.txt"));
  assert.equal(causeId(one.failures[0], one.tool), causeId(two.failures[0], two.tool));
  assert.notEqual(causeId(one.failures[0], one.tool), causeId(one.failures[1], one.tool));
});

// -------------------------------------------------------------------- storage

test("state is kept outside the working directory", () => {
  assert.ok(!resolve(cacheDir({})).startsWith(resolve(process.cwd()) + "/"),
    "whatbroke promises it writes nothing into your project");
});

test("without --since-last nothing is written at all", () => {
  const store = cache();
  spawnSync(process.execPath, [cli], {
    input: fx("pytest_fail.txt"), encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", WHATBROKE_CACHE_DIR: store },
  });
  assert.equal(stored(store).length, 0, "tracking must be opt-in");
});

test("an unwritable cache degrades quietly instead of failing the run", () => {
  const store = cache();
  writeFileSync(join(store, "blocker"), "");          // a file where a dir must go
  const r = run(store, fx("pytest_fail.txt"), []);
  const blocked = spawnSync(process.execPath, [cli, "--since-last"], {
    input: fx("pytest_fail.txt"), encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", WHATBROKE_CACHE_DIR: join(store, "blocker", "sub") },
  });
  assert.equal(blocked.status, 0, "a cache problem must never change the outcome of a run");
  assert.match(blocked.stdout, /3 failed/, "the diagnosis is still printed");
  assert.equal(r.status, 0);
});

for (const d of caches) rmSync(d, { recursive: true, force: true });
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
