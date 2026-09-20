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
import {
  compare,
  cacheDir,
  runIdentity,
  legacyRunIdentity,
  trackedCauseId,
  legacyTrackedCauseId,
} from "../src/history.js";
import { causeId, fingerprint } from "../src/cluster.js";
import { analyse } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "bin", "whatbroke.js");
const fx = (n) => readFileSync(join(here, "fixtures", n), "utf8");

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

const caches = [];
function cache() {
  const d = mkdtempSync(join(tmpdir(), "wb-hist-"));
  caches.push(d);
  return d;
}
// A piped log is only tracked when it is named, so the suite names it. The tests that
// are ABOUT being unnamed pass their own --id-free argv through `bare` below.
const run = (store, input, args = []) => spawnSync(process.execPath,
  [cli, "--since-last", ...(args.includes("--id") ? [] : ["--id", "suite"]), ...args], {
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

test("new and removed secondary-tool causes are tracked and marked", () => {
  const lint = fx("eslint_fail.txt");
  const type = "/app/new.ts(20,7): error TS2322: Type 'string' is not assignable to type 'number'.\n";
  for (const flags of [[], ["--no-cluster"]]) {
    const store = cache();
    run(store, lint, flags);
    const changed = run(store, lint + type, flags);
    assert.equal(changed.status, 0, changed.stderr);
    assert.match(changed.stdout, /1 new since your last run/);
    const marked = changed.stdout.split("\n").filter(l => /\bnew$/.test(l));
    assert.equal(marked.length, 1);
    assert.match(marked[0], /TS2322/);
    assert.equal((changed.stdout.match(/since your last run/g) ?? []).length, 1);
    const same = JSON.parse(run(store, lint + type, [...flags, "--json"]).stdout);
    assert.deepEqual(same.since.fresh, []);
    assert.equal(same.since.gone, 0);
    const removed = JSON.parse(run(store, lint, [...flags, "--json"]).stdout);
    assert.equal(removed.since.gone, 1);
  }
});

test("secondary history is exposed in JSON and the GitHub notice", () => {
  const type = "/app/new.ts(20,7): error TS2322: Type 'string' is not assignable to type 'number'.\n";
  for (const flag of ["--json", "--github-actions"]) {
    const store = cache();
    run(store, fx("eslint_fail.txt"));
    const next = run(store, fx("eslint_fail.txt") + type, [flag]);
    if (flag === "--json") assert.equal(JSON.parse(next.stdout).since.fresh.length, 1);
    else assert.match(next.stdout, /1 new since the last tracked run/);
  }
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

test("a record from an older identity scheme is ignored, not misread", () => {
  for (const version of [1, 2, 3, 4]) {
    const store = cache();
    run(store, fx("pytest_fail.txt"));
    const path = join(store, stored(store)[0]);
    const saved = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...saved, version, causes: [] }));
    const r = run(store, fx("pytest_fail.txt"));
    assert.match(r.stdout, /first tracked run/, "an old record was treated as comparable");
    assert.doesNotMatch(r.stdout, /new since your last run/);
  }
});

// Migration is a COMMAND's business now. The scheme this reads keyed a piped run on the
// directory and tool alone, and those records are precisely the ones several pipelines
// shared - the ambiguity `--id` exists to end - so they are left where they are rather
// than handed to whichever pipeline runs next. A wrapped command names itself in its argv
// and always did, so its own record still migrates.
const ECHO = (text) => [process.execPath, "-e",
  `process.stdout.write(${JSON.stringify(text)}); process.exit(1)`];
const wrapped = (store, text, args = ["--json"]) => spawnSync(process.execPath,
  [cli, "--since-last", ...args, ...ECHO(text)], {
    encoding: "utf8", env: { ...process.env, NO_COLOR: "1", WHATBROKE_CACHE_DIR: store },
  });

test("the last 32-bit history record migrates without inventing new causes", () => {
  const store = cache();
  const log = fx("pytest_fail.txt");
  const parsed = analyse(log);
  const identity = legacyRunIdentity({ cwd: process.cwd(), tool: parsed.tool, argv: ECHO(log) });
  const causes = parsed.failures.map((failure) => legacyTrackedCauseId(failure, parsed.tool));
  writeFileSync(join(store, `${identity}.json`), JSON.stringify({
    version: 4,
    ranAt: "2026-09-09T00:00:00.000Z",
    tool: parsed.tool,
    causes,
  }));

  const result = JSON.parse(wrapped(store, log).stdout).since;
  assert.equal(result.compared, true);
  assert.equal(result.migrated, true);
  assert.deepEqual(result.fresh, []);
  assert.equal(result.gone, null, "legacy collisions make disappearance unsafe to claim");
  assert.equal(result.goneWithheld, "identity-migration");

  const files = stored(store);
  assert.equal(files.length, 2, "the migrated run should be saved under its new identity");
  const currentFile = files.find((file) => /^[0-9a-f]{24}\.json$/.test(file));
  assert.ok(currentFile, "the new 96-bit run identity was not written");
  const next = JSON.parse(readFileSync(join(store, currentFile), "utf8"));
  assert.equal(next.version, 6);
  assert.ok(next.causes.every((id) => /^[0-9a-f]{24}$/.test(id)));

  // The same command with one cause changed. Its argv differs because the log is in it,
  // so the record is seeded under that argv's legacy identity: what is being tested is
  // that a changed cause comes back as a current-scheme id, not as a legacy one.
  const changedStore = cache();
  const changedLog = fx("pytest_fail.txt").replace("KeyError: 'exp'", "KeyError: 'aud'");
  writeFileSync(join(changedStore, `${legacyRunIdentity({ cwd: process.cwd(), tool: parsed.tool, argv: ECHO(changedLog) })}.json`),
    JSON.stringify({ version: 4, ranAt: "2026-09-09T00:00:00.000Z", tool: parsed.tool, causes }));
  const changed = JSON.parse(wrapped(changedStore, changedLog).stdout).since;
  assert.equal(changed.migrated, true);
  assert.equal(changed.fresh.length, 1);
  assert.match(changed.fresh[0], /^[0-9a-f]{24}$/,
    "migration must expose current IDs so the changed cause can be marked new");
});

// ------------------------------------------------------------------ identity

test("persistent fingerprints use 96 bits", () => {
  assert.match(fingerprint("same input, same identity"), /^[0-9a-f]{24}$/);
  assert.equal(fingerprint("same input, same identity"), fingerprint("same input, same identity"));
  assert.notEqual(fingerprint("same input, same identity"), fingerprint("different identity"));
});

test("different commands never compare against each other", () => {
  const a = runIdentity({ cwd: "/p", tool: "pytest", argv: ["pytest", "tests/unit"] });
  const b = runIdentity({ cwd: "/p", tool: "pytest", argv: ["pytest", "tests/api"] });
  assert.notEqual(a, b, "two different test selections are not the same run");
});

test("different directories never compare against each other", () => {
  const base = { cwd: "/p", argv: ["pytest"] };
  assert.notEqual(runIdentity(base), runIdentity({ ...base, cwd: "/other" }));
});

// A command names itself in its argv, and that is what the identity is - not the tool the
// output turned out to be from. It has to be: a run that SUCCEEDS prints nothing to name a
// tool with, and that run is the one that has to be able to write "nothing is failing" to
// the same place the failing run wrote to.
test("a command keeps one identity whether or not its output named a tool", () => {
  const argv = ["pytest", "tests/unit"];
  assert.equal(runIdentity({ cwd: "/p", argv, tool: "pytest" }), runIdentity({ cwd: "/p", argv, tool: null }));
  assert.notEqual(runIdentity({ cwd: "/p", argv }), runIdentity({ cwd: "/p", argv: ["pytest", "tests/api"] }));
});

// A pipe carries no argv at all, so nothing tells one from another in a directory.
// Naming a command does not turn it into a pipeline: it still has to keep the one key its
// own green run can write to, which is the key the tool is kept out of.
test("naming a command does not put the tool back in its identity", () => {
  const named = { cwd: "/p", argv: ["pytest"], id: "nightly" };
  assert.equal(runIdentity({ ...named, tool: "pytest" }), runIdentity({ ...named, tool: null }),
    "a green run of it has no tool and must still land on the same record");
  assert.notEqual(runIdentity(named), runIdentity({ ...named, argv: ["pytest", "tests/api"] }),
    "two commands sharing a name must keep separate histories");
  // A named PIPE does keep the tool, so the same name over two tools is two records.
  const piped = { cwd: "/p", argv: [], id: "nightly" };
  assert.notEqual(runIdentity({ ...piped, tool: "pytest" }), runIdentity({ ...piped, tool: "eslint" }));
  assert.notEqual(runIdentity({ ...named, tool: "pytest" }), runIdentity({ ...piped, tool: "pytest" }));
});

test("an unnamed pipe has no identity, and a named one is per tool", () => {
  assert.equal(runIdentity({ cwd: "/p", argv: [] }), null);
  assert.equal(runIdentity({ cwd: "/p", argv: [], tool: "pytest" }), null);
  const named = { cwd: "/p", argv: [], id: "ci" };
  assert.notEqual(runIdentity({ ...named, tool: "pytest" }), runIdentity({ ...named, tool: "eslint" }));
  assert.notEqual(runIdentity({ ...named, tool: "pytest" }), runIdentity({ ...named, tool: "pytest", cwd: "/other" }));
  assert.notEqual(runIdentity({ ...named, tool: "pytest" }), runIdentity({ ...named, tool: "pytest", id: "nightly" }));
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
  assert.equal(causeId(one.failures[0]), causeId(two.failures[0]));
  assert.notEqual(causeId(one.failures[0]), causeId(one.failures[1]));
});

test("history distinguishes identical diagnostic text from different tools", () => {
  const failure = { code: "E100", message: "Cannot resolve module" };
  assert.notEqual(trackedCauseId(failure, "tool-a"), trackedCauseId(failure, "tool-b"));
  assert.equal(trackedCauseId(failure, "tool-a"), trackedCauseId({ ...failure, line: 20 }, "tool-a"));
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

// ------------------------------------------------- a run that worked is also news

// The same command, run three times: it fails, it passes, it fails the same way again.
// A green run used to write nothing at all, so the record still held the first failure -
// and when that failure came back, whatbroke compared it against the run that found it
// and said nothing was new. A passing run in between is exactly when a reader most wants
// the next break called new.
const CHILD = `
  if (process.env.QUIET) { console.log("======== 1 passed in 0.01s ========"); process.exit(0); }
  console.log("=========================== short test summary info ============================");
  console.log("FAILED tests/t.py::test_x - KeyError: 'expiry_token'");
  console.log("======== 1 failed in 0.01s ========");
  process.exit(Number(process.env.RC));
`;
/** `mode` is "fail", "pass", or "pass-noisy" - a command that exits ZERO while still
 *  printing something a parser reads. Real runners do: a suite told to tolerate a known
 *  failure, a wrapper echoing the last run's summary, a linter reporting only warnings. */
const suite = (store, mode, args = ["--json"]) => spawnSync(process.execPath,
  [cli, "--since-last", ...args, process.execPath, "-e", CHILD], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", WHATBROKE_CACHE_DIR: store,
      QUIET: mode === "pass" ? "1" : "", RC: mode === "fail" ? "1" : "0" },
  });

test("a failure that returns after a green run is new again", () => {
  const store = cache();
  const first = JSON.parse(suite(store, "fail").stdout).since;
  assert.equal(first.compared, false);
  assert.equal(first.reason, "no-previous-run");

  const green = suite(store, "pass");
  assert.equal(green.status, 0);
  assert.equal(stored(store).length, 1, "and the green run writes to the SAME record");

  const again = JSON.parse(suite(store, "fail").stdout).since;
  assert.equal(again.compared, true);
  assert.equal(again.fresh.length, 1, "the failure came back after a run that passed: it is new");
});

test("a command that worked prints nothing of whatbroke's own", () => {
  const store = cache();
  const green = suite(store, "pass", []);
  assert.equal(green.status, 0);
  assert.equal(green.stdout, "======== 1 passed in 0.01s ========\n",
    "only the command's own output, and no report over it");
});

test("a green run records that nothing is failing, not nothing at all", () => {
  const store = cache();
  suite(store, "fail");
  suite(store, "pass");
  const record = JSON.parse(readFileSync(join(store, stored(store)[0]), "utf8"));
  assert.deepEqual(record.causes, [], "the baseline a green run leaves is the empty one");
  assert.equal(record.version, 6);
});

// Exiting zero is the statement, not the output. A runner can exit zero having printed
// something a parser reads perfectly well, and the causes read out of that are not things
// that are failing. The terminal path never reached the recording code with a reading in
// hand, so it got this right; JSON did, and stored the reading as the live baseline - so
// the same command passing left a record saying its failures were still there, and the
// next real break was compared against them and called nothing new.
test("a command that exits zero records an empty baseline even in JSON", () => {
  const store = cache();
  suite(store, "fail");
  const green = JSON.parse(suite(store, "pass-noisy").stdout);
  // Everything that was read is still reported. Only the baseline is empty.
  assert.equal(green.tool, "pytest");
  assert.equal(green.failures.length, 1);
  assert.equal(green.failures[0].message, "KeyError: 'expiry_token'");
  assert.equal(green.commandExitCode, 0);
  assert.deepEqual(green.since.fresh, []);
  assert.equal(green.since.gone, 1, "the command succeeded, so what was failing is not");
  const record = JSON.parse(readFileSync(join(store, stored(store)[0]), "utf8"));
  assert.deepEqual(record.causes, []);

  const again = JSON.parse(suite(store, "fail").stdout).since;
  assert.equal(again.compared, true);
  assert.equal(again.fresh.length, 1, "the failure after a passing run is new, whatever that run printed");
});

test("the baseline a green run leaves does not depend on the output format", () => {
  const records = [["--json"], ["--format=terminal"], ["--format=github"]].map((args) => {
    const store = cache();
    suite(store, "fail", args);
    suite(store, "pass-noisy", args);
    const saved = JSON.parse(readFileSync(join(store, stored(store)[0]), "utf8"));
    delete saved.ranAt;
    return saved;
  });
  assert.deepEqual(records[1], records[0]);
  assert.deepEqual(records[2], records[0]);
  assert.deepEqual(records[0].causes, []);
});

// ------------------------------------------------- a pipe nobody named is nobody's

// `pytest tests/unit | whatbroke --since-last` and `pytest tests/api | whatbroke
// --since-last` run from one directory carry no argv at all, so they shared a single
// record: each overwrote the other, and each reported the other's failures as GONE - a
// claim that something was fixed, about a suite that had not even run.
test("two unnamed pipes never compare against each other", () => {
  const store = cache();
  const unit = `=========================== short test summary info ============================
FAILED tests/unit/a.py::t1 - KeyError: 'expiry_token'
======== 1 failed in 0.01s ========`;
  const api = `=========================== short test summary info ============================
FAILED tests/api/b.py::t2 - ConnectionRefusedError: billing gateway
======== 1 failed in 0.01s ========`;
  const bare = (input) => spawnSync(process.execPath, [cli, "--since-last", "--json"], {
    input, encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", WHATBROKE_CACHE_DIR: store },
  });
  for (const log of [unit, api, unit]) {
    const since = JSON.parse(bare(log).stdout).since;
    assert.equal(since.compared, false);
    assert.equal(since.reason, "unidentified-pipe");
    assert.equal(since.recorded, false);
    assert.equal(since.gone, null, "nothing may be claimed to have gone");
  }
  assert.equal(stored(store).length, 0, "an unnamed pipe leaves no record to mislead the next one");
});

// --id opens a namespace of its own, and the scheme before this one had no --id: every
// record it wrote was keyed on the directory, the tool and the argv alone. So the legacy
// record sitting under a named pipeline's directory and tool was written by some UNNAMED
// pipe - the sharing --id exists to end - and migrating it hands a brand-new pipeline
// another one's history and calls the two compared.
test("a named pipeline never adopts an unnamed one's legacy record", () => {
  const store = cache();
  const parsed = analyse(fx("pytest_fail.txt"));
  const identity = legacyRunIdentity({ cwd: process.cwd(), tool: parsed.tool, argv: [] });
  writeFileSync(join(store, `${identity}.json`), JSON.stringify({
    version: 4,
    ranAt: "2026-09-09T00:00:00.000Z",
    tool: parsed.tool,
    causes: parsed.failures.map((failure) => legacyTrackedCauseId(failure, parsed.tool)),
  }));

  const since = JSON.parse(run(store, fx("pytest_fail.txt"), ["--json", "--id", "brand-new"]).stdout).since;
  assert.equal(since.compared, false, "a pipeline nobody has run before has nothing to compare with");
  assert.equal(since.reason, "no-previous-run");
  assert.notEqual(since.migrated, true);
  assert.equal(since.gone, null);
  // Somebody else's record is left exactly where it was, unread and unreplaced.
  assert.equal(stored(store).length, 2);
  assert.equal(JSON.parse(readFileSync(join(store, `${identity}.json`), "utf8")).version, 4);
  // The identity itself is what refuses: there is no legacy key for a named run.
  assert.equal(legacyRunIdentity({ cwd: "/p", tool: "pytest", argv: [], id: "x" }), null);
  assert.notEqual(legacyRunIdentity({ cwd: "/p", tool: "pytest", argv: [] }), null);
});

test("an unnamed pipe says why it was not tracked", () => {
  const store = cache();
  const r = spawnSync(process.execPath, [cli, "--since-last"], {
    input: fx("pytest_fail.txt"), encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", WHATBROKE_CACHE_DIR: store },
  });
  // Printing nothing would read as "nothing new", which is the claim being refused.
  assert.match(r.stdout, /not tracked/);
  assert.match(r.stdout, /--id NAME/);
});

test("--id is what makes two pipelines two", () => {
  const store = cache();
  const named = (input, id) => JSON.parse(spawnSync(process.execPath,
    [cli, "--since-last", "--json", "--id", id], {
      input, encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1", WHATBROKE_CACHE_DIR: store },
    }).stdout).since;
  assert.equal(named(fx("pytest_fail.txt"), "unit").reason, "no-previous-run");
  assert.equal(named(fx("pytest_tb_short_fail.txt"), "api").reason, "no-previous-run");
  const back = named(fx("pytest_fail.txt"), "unit");
  assert.equal(back.compared, true);
  assert.equal(back.fresh.length, 0, "its own last run, not the other pipeline's");
  assert.equal(back.gone, 0);
  assert.equal(stored(store).length, 2);
});

test("one --id over two wrapped commands does not claim the first command's failures are gone", () => {
  const store = cache();
  const unit = wrapped(store, fx("pytest_fail.txt"), ["--json", "--id", "ci"]);
  const api = wrapped(store, fx("pytest_tb_short_fail.txt"), ["--json", "--id", "ci"]);
  assert.equal(unit.status, 1);
  assert.equal(api.status, 1);
  assert.equal(JSON.parse(unit.stdout).since.reason, "no-previous-run");
  const second = JSON.parse(api.stdout).since;
  assert.equal(second.compared, false);
  assert.equal(second.reason, "no-previous-run");
  assert.equal(second.gone, null, "another command's failures were not checked here");
  assert.equal(stored(store).length, 2);
});

// --------------------------------------------------------------- what it costs

// `gone` was counted by scanning the whole current list once per remembered cause. A suite
// with a thousand of each did a million string comparisons for one number, and a suite big
// enough to want --since-last is exactly the one that has them. Both directions are set
// membership; the numbers below take milliseconds and took tens of seconds.
test("comparing two large runs is linear, not quadratic", () => {
  // 40,000 each way: 1263ms before this, 8ms after, measured on the machine it was
  // written on. The threshold leaves room for a runner several times slower than that
  // and still refuses the quadratic scan by a wide margin.
  const n = 40000;
  const previous = { causes: Array.from({ length: n }, (_, i) => `cause${i}`), ranAt: null };
  const current = Array.from({ length: n }, (_, i) => `cause${i + n / 2}`);
  const started = Date.now();
  const result = compare(previous, current, {});
  const took = Date.now() - started;
  assert.equal(result.fresh.length, n / 2);
  assert.equal(result.gone, n / 2);
  assert.ok(took < 400, `comparing ${n} causes with ${n} took ${took}ms`);
});

for (const d of caches) rmSync(d, { recursive: true, force: true });
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
