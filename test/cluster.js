// Grouping failures into likely causes.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { analyse } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n) => readFileSync(join(here, "fixtures", n), "utf8");
const cli = join(here, "..", "bin", "whatbroke.js");

let pass = 0, fail = 0;


// ---------------------------------------------------------------- clustering

// skeleton() is pinned exactly: these are the rules, and they must not drift.
try {
  const { skeleton } = await import("../src/cluster.js");
  const table = [
    [`assert 'Error: Missing argument' in "Usage:\ncli"`, "assert <str> in <str>"],
    ["KeyError: 'exp'", "KeyError: exp"],
    ["Cannot read properties of null (reading 'id')", "Cannot read properties of null (reading id)"],
    ["<click.testing.CliRunner object at 0x10c3f4d90>", "<click.testing.CliRunner object at <addr>>"],
    ["assert 1049 == 1050", "assert <num> == <num>"],
    ["expected `String`, found integer", "expected String, found integer"],
    ["test_shop.py:4: AssertionError", "<path>:<num>: AssertionError"],
    ["cart.total is not a function", "cart.total is not a function"],
    [`Argument 1 to "total" has incompatible type "str"`, "Argument <num> to total has incompatible type str"],
    ["doesn't exist on type 'User'", "doesn't exist on type User"],
    ["assert total([1000, 49], 0.5) == 1050", "assert total([<num>*], <num>) == <num>"],
    ["error[E0308] TS2551 i64 utf8", "error[E0308] TS2551 i64 utf8"],
  ];
  for (const [input, want] of table) {
    assert.equal(skeleton(input), want, `skeleton(${JSON.stringify(input)})`);
  }
  console.log(`  ok   skeleton normalises ${table.length} known shapes exactly`);
  pass++;
} catch (e) { console.log(`  FAIL skeleton table\n       ${e.message}`); fail++; }

// Every rule gets a pair: one that MUST join (fails if the rule is deleted) and one
// that MUST split (fails if the rule is widened). Pinned from both sides.
try {
  const { skeleton } = await import("../src/cluster.js");
  const same = (a, b) => skeleton(a) === skeleton(b);
  const join = [
    ["numbers", "assert cart.total() == 1050", "assert cart.total() == 1051"],
    ["quoted data", `assert 'Error: A' in out`, `assert 'Error: B B' in out`],
    ["quote style", `KeyError: 'exp'`, `KeyError: "exp"`],
    ["paths", "at tests/a/b.py line 1", "at src/c/d.py line 99"],
    ["addresses", "<X object at 0x1a2b>", "<X object at 0xffee>"],
    ["numeric runs", "call([1, 2, 3])", "call([7, 8, 9])"],
    // "/route.json" hits the extension rule and "/foo/bar" the separator rule; if the
    // extension rule leaves the leading slash behind they never cluster together
    ["path shape is consistent across sub-rules", "equal { path: '/route.json' }", "equal { path: '/foo/bar' }"],
  ];
  const split = [
    ["diagnostic codes survive <num>", "TS2551 not assignable", "TS2339 not assignable"],
    ["quoted identifiers kept", "KeyError: 'exp'", "KeyError: 'sub'"],
    ["type names kept", `type 'string' bad`, `type 'Buffer' bad`],
    ["attribute access is not a path", "cart.total is not a function", "user.save is not a function"],
    ["hex needs a digit", "defaced the value", "deadbee the value"],
    ["brackets in messages kept", "expected list[int]", "expected list[str]"],
    ["apostrophe lookbehind", "doesn't exist on type 'User'", "doesn't exist on type 'Post'"],
  ];
  for (const [why, a, b] of join) assert.ok(same(a, b), `must JOIN (${why}): ${skeleton(a)} vs ${skeleton(b)}`);
  for (const [why, a, b] of split) assert.ok(!same(a, b), `must SPLIT (${why}): both ${skeleton(a)}`);
  console.log(`  ok   ${join.length} must-join and ${split.length} must-split rules hold`);
  pass++;
} catch (e) { console.log(`  FAIL join/split pairs\n       ${e.message}`); fail++; }

// Clusters must partition the failures: nothing lost, nothing double counted.
try {
  let checked = 0;
  for (const file of readdirSync(join(here, "fixtures"))) {
    const r = analyse(fx(file));
    if (!r) continue;
    checked++;
    const members = r.clusters.flatMap((c) => c.members).sort((a, b) => a - b);
    assert.deepEqual(members, [...r.failures.keys()], `${file}: not a partition`);
    for (const c of r.clusters) {
      assert.equal(c.size, c.members.length, `${file}: size disagrees with members`);
      assert.ok(c.members.includes(c.exemplar), `${file}: exemplar outside its cluster`);
    }
    assert.equal(r.clusters.reduce((n, c) => n + c.size, 0), r.failures.length, `${file}: sizes do not sum`);
  }
  console.log(`  ok   clusters partition every failure across ${checked} fixtures`);
  pass++;
} catch (e) { console.log(`  FAIL cluster partition\n       ${e.message}`); fail++; }

// A normalisation rule that eats its own output looks fine until it silently
// changes results. Idempotence catches that class outright.
try {
  const { skeleton } = await import("../src/cluster.js");
  let n = 0;
  for (const file of readdirSync(join(here, "fixtures"))) {
    const r = analyse(fx(file));
    if (!r) continue;
    for (const f of r.failures) {
      for (const t of [f.message, f.stmt, f.title]) {
        const once = skeleton(t);
        assert.equal(skeleton(once), once, `${file}: skeleton not idempotent on ${JSON.stringify(String(t).slice(0, 60))}`);
        n++;
      }
    }
  }
  console.log(`  ok   skeleton is idempotent over ${n} real strings`);
  pass++;
} catch (e) { console.log(`  FAIL skeleton idempotence\n       ${e.message}`); fail++; }

// Clustering must not change what anyone already sees. Any fixture that legitimately
// grows a cluster belongs in this list, with a reason - so a merge can never appear
// silently in someone's terminal.
try {
  const { render, setColor } = await import("../src/render.js");
  setColor(false);
  // Fixtures that legitimately group. Anything not listed here must render
  // byte-identically with clustering on, so a merge can never appear silently.
  const EXPECTED_TO_CLUSTER = [
    "gotest_cluster_fail.txt",   // three tests share one assertion shape
    "eslint_bulk_fail.txt",      // one rule broken in twenty-two places
    "mypy_notes_fail.txt",       // several type errors repeat across modules
    "clang_bulk_fail.txt",       // one signature change, fourteen call sites
    "clippy_fail.txt",           // one lint in several places is one fix
    "flake8_fail.txt",           // the same whitespace rule in three places
    "swiftc_bulk_fail.txt",      // eight assignments of the same wrong type, one cause
  ];
  let checked = 0;
  for (const file of readdirSync(join(here, "fixtures"))) {
    const raw = fx(file);
    const on = analyse(raw), off = analyse(raw, { cluster: false });
    if (!on) continue;
    checked++;
    const differs = render(on, {}) !== render(off, { cluster: false });
    if (EXPECTED_TO_CLUSTER.includes(file)) assert.ok(differs, `${file}: expected to cluster but did not`);
    else assert.ok(!differs, `${file}: clustering changed existing output`);
  }
  console.log(`  ok   clustering changes ${EXPECTED_TO_CLUSTER.length} of ${checked} fixture renders, the ${EXPECTED_TO_CLUSTER.length === 1 ? "one" : "ones"} expected to`);
  pass++;
} catch (e) { console.log(`  FAIL byte identity\n       ${e.message}`); fail++; }

// A failure says what it is. `code` is a diagnostic identifier, `subject` is the name
// of the site that failed, `label` is a constant the tool prints for a class of
// failure - and they are mutually exclusive, because clustering treats them as opposite
// things. Declaring two would mean the parser has not decided which it produced.
try {
  const tools = new Set();
  const unclassifiedBy = new Set();
  let classified = 0, total = 0;
  for (const file of readdirSync(join(here, "fixtures"))) {
    const r = analyse(fx(file));
    if (!r) continue;
    tools.add(r.tool);
    for (const f of r.failures) {
      total++;
      const declared = ["code", "subject", "label"].filter((k) => f[k]);
      assert.ok(declared.length <= 1,
        `${r.tool} declares ${declared.join(" and ")} on one failure; they are alternatives`);
      if (declared.length) classified++; else unclassifiedBy.add(r.tool);
      assert.ok(f.severity, `${r.tool} emitted a failure with no severity`);
      assert.notEqual(f.severity, "warning", `${r.tool} reported a warning as a failure`);
    }
  }
  // A ratio let a new parser quietly spend the budget: swift declared nothing for a
  // whole release and stayed inside 95%, and the cost was that eight identical errors
  // could not be grouped. The exceptions are named instead, and they are the tools that
  // genuinely print no identifier of any kind:
  //
  //   generic   a guess, by definition unidentified
  //   go        writes "./main.go:6:18: cannot use ..." with no severity word at all,
  //             so calling it "error" would be inventing one
  //
  // Anything else reaching here is a parser that has not said what it produced.
  const MAY_BE_UNCLASSIFIED = new Set(["output", "go build", "go vet", "go test"]);
  const undeclared = [...unclassifiedBy].filter((t) => !MAY_BE_UNCLASSIFIED.has(t));
  assert.deepEqual(undeclared, [],
    "a parser emitted a failure declaring neither code, subject nor label");
  assert.ok(classified / total > 0.95, `only ${classified} of ${total} failures are classified`);
  console.log(`  ok   ${classified} of ${total} failures across ${tools.size} tools declare what they are`);
  pass++;
} catch (e) { console.log(`  FAIL failure classification\n       ${e.message}`); fail++; }

// The clustering policy used to be a table keyed on 27 tool strings. It now falls out
// of what the failure declares, and these are the three behaviours that table encoded.
try {
  const { clusterFailures, keyOf } = await import("../src/cluster.js");
  const msg = "AssertionError: totals disagree";
  // a subject is the axis clustered ACROSS, so two sites with one cause group
  const sites = [1, 2, 3].map((n) => ({ subject: `test_case_${n}`, message: msg, file: "a.py", line: n }));
  assert.equal(clusterFailures(sites).filter((c) => c.reported).length, 1,
    "failures differing only in subject are one cause");
  // a code is the identity, so two codes never merge however alike the message
  const codes = [1, 2, 3, 4, 5, 6].map((n) => ({ code: n > 3 ? "E001" : "E002", message: msg, file: "a.rs", line: n }));
  assert.equal(clusterFailures(codes).filter((c) => c.reported).length, 2,
    "two diagnostic codes are two causes");
  // with a code present the echoed statement is the instance, not the identity
  const withStmt = { code: "TS2551", message: msg, stmt: "a.b()" };
  assert.equal(keyOf(withStmt), keyOf({ ...withStmt, stmt: "c.d()" }),
    "the statement must not split one diagnostic code into two causes");
  // without one it is the strongest discriminator there is, so it stays
  const noCode = { subject: "test_x", message: msg, stmt: "assert a == b" };
  assert.notEqual(keyOf(noCode), keyOf({ ...noCode, stmt: "assert c == d" }),
    "without a code the statement must still discriminate");
  console.log("  ok   clustering policy follows the failure's own fields");
  pass++;
} catch (e) { console.log(`  FAIL field-derived clustering policy\n       ${e.message}`); fail++; }

// The guards against over-merging, which is the fatal direction.
try {
  const { clusterFailures, MIN_CLUSTER } = await import("../src/cluster.js");
  // 40 numeric assertions from 40 unrelated bugs must never become "1 likely cause"
  const bare = Array.from({ length: 40 }, (_, i) => ({ title: `t${i}`, message: `assert ${i} == ${i + 1}` }));
  assert.ok(clusterFailures(bare, "pytest").every((c) => !c.reported),
    "a bare numeric assertion carries no information and must not be a reported cause");

  // three failures that really do share a cause
  const real = Array.from({ length: 3 }, (_, i) => ({ title: `t${i}`, file: `a${i}.py`, line: i + 1, message: "KeyError: 'exp'" }));
  const got = clusterFailures(real, "pytest").filter((c) => c.reported);
  assert.equal(got.length, 1, "three matching failures should be one reported cause");
  assert.equal(got[0].size, 3);

  // two is coincidence, not a cause
  assert.equal(MIN_CLUSTER, 3);
  assert.ok(clusterFailures(real.slice(0, 2), "pytest").every((c) => !c.reported), "two must not be reported");
  console.log("  ok   the information gate and minimum size both refuse weak merges");
  pass++;
} catch (e) { console.log(`  FAIL merge guards\n       ${e.message}`); fail++; }

// Captured Node assertions have a verbose matcher header, but still carry no
// shared cause when all that remains underneath it is a numeric comparison.
try {
  const { render } = await import("../src/render.js");
  const { clusterFailures } = await import("../src/cluster.js");
  const r = analyse(fx("nodetest_nested_fail.txt"));
  assert.ok(r.clusters.every((c) => !c.reported), "matcher boilerplate must not justify grouping");
  const out = render(r, { source: false, max: Infinity });
  assert.doesNotMatch(out, /likely cause/);
  for (const comparison of ["2 !== 3", "4 !== 5", "6 !== 7"]) assert.ok(out.includes(comparison));
  // A shared expression is still useful evidence; this must not disable all
  // assertion clustering merely because the framework supplies a header.
  const withExpression = r.failures.map((f) => ({ ...f, stmt: "assert.equal(cart.total(), expected)" }));
  assert.equal(clusterFailures(withExpression, r.tool).filter((c) => c.reported).length, 1);
  console.log("  ok   Node assertion boilerplate cannot merge unrelated numeric failures");
  pass++;
} catch (e) { console.log(`  FAIL Node assertion grouping\n       ${e.message}`); fail++; }

// Rendering a real cluster: header, one exemplar, distinct sites only.
try {
  const { render, setColor } = await import("../src/render.js");
  const { clusterFailures } = await import("../src/cluster.js");
  setColor(false);
  const failures = [
    { title: "test_a", file: "t/one.py", line: 10, message: "KeyError: 'exp'" },
    { title: "test_b", file: "t/two.py", line: 20, message: "KeyError: 'exp'" },
    { title: "test_c", file: "t/two.py", line: 20, message: "KeyError: 'exp'" },
    { title: "test_d", file: "t/three.py", line: 30, message: "KeyError: 'exp'" },
  ];
  const out = render({ tool: "pytest", failures, clusters: clusterFailures(failures, "pytest") }, { source: false });
  assert.match(out, /1 likely cause, 4 sites/, "header must state the cause count");
  assert.equal((out.match(/KeyError/g) || []).length, 1, "the exemplar message prints once, not once per member");
  assert.match(out, /also t\/two\.py:20, t\/three\.py:30/, "sibling sites are named");
  assert.equal((out.match(/t\/two\.py:20/g) || []).length, 1, "a repeated location is named once, not per member");
  console.log("  ok   a cluster renders one exemplar and its distinct sites");
  pass++;
} catch (e) { console.log(`  FAIL cluster rendering\n       ${e.message}`); fail++; }

// Hostile input must still yield a valid partition, not merely avoid throwing.
try {
  const hostile = ["", "\0\0", "[31m", "!!!".repeat(1000), "a".repeat(50000),
    "assert 'unterminated in x", "{}", "::::", "\n\n\n", "error: " + "x".repeat(5000)];
  for (const h of hostile) {
    const r = analyse(h);
    if (!r) continue;
    const members = r.clusters.flatMap((c) => c.members).sort((a, b) => a - b);
    assert.deepEqual(members, [...r.failures.keys()], `hostile input broke the partition: ${JSON.stringify(h.slice(0, 20))}`);
  }
  console.log("  ok   hostile input still produces a valid partition");
  pass++;
} catch (e) { console.log(`  FAIL hostile partition\n       ${e.message}`); fail++; }

// --no-cluster must mean no clustering everywhere, not "clustered but hidden".
try {
  const off = spawnSync(process.execPath, [cli, "--format", "json", "--no-cluster", "--", process.execPath, "-e", "null.x"], { encoding: "utf8" });
  assert.equal(JSON.parse(off.stdout).clusters, null, "--no-cluster must null the clusters field in JSON too");
  const on = spawnSync(process.execPath, [cli, "--format", "json", "--", process.execPath, "-e", "null.x"], { encoding: "utf8" });
  assert.ok(Array.isArray(JSON.parse(on.stdout).clusters), "clustering is on by default");
  console.log("  ok   --no-cluster disables clustering in every format");
  pass++;
} catch (e) { console.log(`  FAIL --no-cluster flag\n       ${e.message}`); fail++; }

// no rendered line may run away, however long the paths in a cluster's site list
try {
  const { render, setColor } = await import("../src/render.js");
  setColor(false);
  const long = (n) => `packages/some-workspace/src/adapters/very/deep/module-${n}.js`;
  const failures = Array.from({ length: 12 }, (_, i) => ({
    file: long(i), line: 100 + i, title: "eqeqeq", message: "Expected '===' and instead saw '=='",
  }));
  const { clusterFailures } = await import("../src/cluster.js");
  const out = render({ tool: "eslint", failures, clusters: clusterFailures(failures, "eslint") }, { source: false });
  const longest = Math.max(...out.split("\n").map((l) => l.length));
  assert.ok(longest <= 240, `a site list ran to ${longest} characters`);
  assert.match(out, /more places/, "the sites that did not fit are counted");
  console.log("  ok   a cluster's site list stays within a line");
  pass++;
} catch (e) { console.log(`  FAIL site list width\n       ${e.message}`); fail++; }

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
