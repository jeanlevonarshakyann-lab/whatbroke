// Every suite has to run somewhere. The test script is split so CI can run the slow
// shredded-log suite on fewer machines than the rest, and a split is exactly where a
// suite falls out of both halves with nothing failing - the suites that are left all
// pass. This pins the plumbing instead: each file in test/ runs in one half (or is a
// module a suite imports), `npm test` runs both halves, and the workflow runs each half
// and holds the one required check until both have passed.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const { scripts } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const workflow = readFileSync(join(root, ".github", "workflows", "test.yml"), "utf8").replace(/\r\n?/g, "\n");

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
};
// A suite's path under test/, which may be in a directory of its own: `tools/python.js`.
// Every script under test/, in directories too, as a path from test/ - not the fixtures.
const scripts_ = (dir, prefix = "") => readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
  entry.isDirectory() ? (entry.name === "fixtures" ? [] : scripts_(join(dir, entry.name), `${prefix}${entry.name}/`))
    : entry.name.endsWith(".js") ? [`${prefix}${entry.name}`] : []);
const ran = (script) => [...String(script ?? "").matchAll(/\bnode test\/((?:[\w.-]+\/)*[\w.-]+\.js)\b/g)].map((m) => m[1]);
// A job's block: its key at two spaces, up to the next key at two spaces.
const job = (name) => workflow.match(new RegExp(`^  ${name}:\\n((?:(?!  \\S).*\\n?)*)`, "m"))?.[1] ?? null;

console.log("\nsuites");

test("every test file runs in exactly one half, or is imported by a suite that does", () => {
  const suites = [...ran(scripts["test:fast"]), ...ran(scripts["test:heavy"])];
  const files = scripts_(here).sort();
  // imported by a suite, named the way that suite names it: "./harness.js" from beside it
  const imported = (f) => suites.some((s) => files.includes(s) &&
    readFileSync(join(here, s), "utf8").includes(`"./${posix.relative(posix.dirname(s), f)}"`));
  const problems = [];
  for (const f of files) {
    const n = suites.filter((s) => s === f).length;
    if (n > 1) problems.push(`${f} runs ${n} times`);
    if (n === 0 && !imported(f)) problems.push(`${f} never runs`);
  }
  for (const s of suites) if (!files.includes(s)) problems.push(`${s} is in a script but does not exist`);
  assert.deepEqual(problems, []);
});

test("npm test runs both halves", () => {
  assert.match(scripts.test, /\bnpm run test:fast\b/);
  assert.match(scripts.test, /\bnpm run test:heavy\b/);
});

test("the workflow runs each half, and the required check waits for both", () => {
  const fast = job("fast"), heavy = job("heavy"), ci = job("ci");
  assert.ok(fast, "no fast job");
  assert.ok(heavy, "no heavy job");
  assert.ok(ci, "no ci job");
  assert.match(fast, /^\s+- run: npm run test:fast\s*$/m);
  assert.match(heavy, /^\s+- run: npm run test:heavy\s*$/m);
  assert.match(ci, /^\s+needs: \[fast, heavy\]\s*$/m);
  // Without always(), a failed half skips this job rather than failing it, and GitHub
  // reports a skipped job as a success - even when it is the required check.
  assert.match(ci, /^\s+if: always\(\)\s*$/m);
  assert.match(ci, /needs\.fast\.result \}\}" = success/);
  assert.match(ci, /needs\.heavy\.result \}\}" = success/);
});

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
