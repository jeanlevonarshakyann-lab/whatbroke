// One report, and the schema it keeps.
//
// `--json` prints a report, the terminal and GitHub Actions render the same one, and
// report.schema.json says what it holds. A schema nothing checks is a description of what
// the code did on the day it was written, so these hold every report the corpus produces
// to it - strictly, so that a field whatbroke writes and the schema does not document is
// refused - and to what a report says of itself that a schema cannot: that each group
// holds its own failures once, that its exit codes agree, that nothing unread is reported.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyse, EXTRACTORS } from "../src/index.js";
import { createReport } from "../src/report.js";
import { renderReport } from "../src/render.js";
import { githubOutput } from "../src/github.js";
import { REPORT_SCHEMA, inconsistencies, unknownKeywords, validate } from "./schema.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const fixtures = join(here, "fixtures");
const cli = join(root, "bin", "whatbroke.js");

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
};

const names = readdirSync(fixtures).sort();
const read = (name) => readFileSync(join(fixtures, name), "utf8");
// What a consumer receives: a field set to undefined is not in it.
const asJson = (value) => JSON.parse(JSON.stringify(value));
const reportOf = (text, { cluster = true, exitCode = 0, inputMode = "pipe" } = {}) =>
  createReport({ analysis: analyse(text, { cluster }), raw: text, exitCode, inputMode });
const problems = (report) => [...validate(asJson(report), REPORT_SCHEMA, { strict: true }), ...inconsistencies(asJson(report))];

const cache = mkdtempSync(join(tmpdir(), "wb-report-"));
const run = (args, input = "") => spawnSync(process.execPath, [cli, ...args], {
  input, encoding: "utf8", timeout: 20000, maxBuffer: 64 * 1024 * 1024,
  env: { ...process.env, NO_COLOR: "1", GITHUB_STEP_SUMMARY: "", WHATBROKE_CACHE_DIR: cache },
});

console.log("\nreport");

test("the schema uses no keyword its validator would skip", () => {
  assert.deepEqual(unknownKeywords(REPORT_SCHEMA), []);
});

test("the schema is published with the package, at the address it names", () => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.ok(manifest.files.includes("report.schema.json"), "report.schema.json is not in package.json's files");
  assert.equal(REPORT_SCHEMA.$id, "https://raw.githubusercontent.com/jeanlevonarshakyann-lab/whatbroke/main/report.schema.json");
  assert.equal(REPORT_SCHEMA.properties.version.const, 1);
});

// A validator that passes everything passes every other test in this file. Each keyword
// the schema uses has to refuse the report that breaks it.
test("the validator refuses what each keyword in the schema is there to refuse", () => {
  const base = reportOf(read("golangci_typecheck_fail.txt"));
  assert.ok(base.others?.length && base.clusters?.length, "the base report should hold another tool and clusters");
  const since = { compared: true, reason: null, fresh: ["0123456789abcdef01234567"], gone: 0, ranAt: "2026-09-14T10:00:00.000Z", goneWithheld: null, recorded: true };
  const fallback = createReport({ analysis: null, raw: "nothing a parser reads\n", exitCode: 3, inputMode: "command" });
  const valid = [asJson({ ...base, since }), asJson(fallback)];
  for (const report of valid) assert.deepEqual(problems(report), []);
  const breaks = {
    "a version it is not": (r) => { r.version = 2; },
    "a tool that is a number": (r) => { r.tool = 7; },
    "a tool with no name": (r) => { r.tool = ""; },
    "an input mode there is none of": (r) => { r.inputMode = "socket"; },
    "an exit code below zero": (r) => { r.exitCode = -1; },
    "no failures array": (r) => { delete r.failures; },
    "a wrapper with no text": (r) => { r.wrappers = [""]; },
    "a failure with no message": (r) => { delete r.failures[0].message; },
    "a failure on line 0": (r) => { r.failures[0].line = 0; },
    "a failure on line 1.5": (r) => { r.failures[0].line = 1.5; },
    "a failure in column 0": (r) => { r.failures[0].col = 0; },
    "a failure whose severity is fatal error": (r) => { r.failures[0].severity = "fatal error"; },
    "a failure of a category there is none of": (r) => { r.failures[0].category = "misc"; },
    "a frame that is not text": (r) => { r.failures[0].trace = [12]; },
    "a cluster with no members": (r) => { r.clusters[0].members = []; },
    "a cluster whose id is not a fingerprint": (r) => { r.clusters[0].id = "abc"; },
    "another tool with no failures": (r) => { r.others[0].failures = []; },
    "another tool counting none": (r) => { r.others[0].count = 0; },
    "another tool's failure on line 0": (r) => { r.others[0].failures[0].line = 0; },
    "a cause that is not a fingerprint": (r) => { r.since.fresh = ["new"]; },
    "a comparison withheld for no reason given": (r) => { r.since.goneWithheld = "tired"; },
    "a comparison missing its count": (r) => { delete r.since.gone; },
    "a field nothing documents": (r) => { r.failures[0].origin = "maven"; },
  };
  const fallbackBreaks = {
    "a fallback for a reason there is none of": (r) => { r.fallback.reason = "bored"; },
    "a fallback with no captured output": (r) => { delete r.fallback.rawOutput; },
    "a fallback that is a string": (r) => { r.fallback = "nothing"; },
  };
  const missed = [];
  for (const [what, change, report] of [
    ...Object.entries(breaks).map(([what, change]) => [what, change, valid[0]]),
    ...Object.entries(fallbackBreaks).map(([what, change]) => [what, change, valid[1]]),
  ]) {
    const broken = structuredClone(report);
    change(broken);
    if (!validate(broken, REPORT_SCHEMA, { strict: true }).length) missed.push(what);
  }
  assert.deepEqual(missed, [], "the validator accepted a report that breaks the schema");
  // and the published schema, unlike the tests, leaves room for fields version 1 gains
  const later = structuredClone(valid[0]);
  later.failures[0].origin = "maven";
  later.evidence = [];
  assert.deepEqual(validate(later), []);
});

test("every fixture's report keeps to the schema, and to itself", () => {
  const wrong = [];
  for (const name of names) {
    const text = read(name);
    for (const [label, report] of [
      ["piped", reportOf(text)],
      ["run, unclustered", reportOf(text, { cluster: false, exitCode: 1, inputMode: "command" })],
    ]) {
      for (const problem of problems(report)) wrong.push(`${name} (${label}): ${problem}`);
    }
  }
  assert.deepEqual(wrong.slice(0, 8), [], `${wrong.length} problems`);
});

// What a parser returns is what the report's failures are built from: every field the
// report documents and nothing else, less the two the reader adds - the tool's name on
// each failure, and the category a parser need not state when it is the parser's own.
test("every parser's own result keeps to what a report is built from", () => {
  const { tool, ...properties } = REPORT_SCHEMA.$defs.failure.properties;
  const contract = {
    $defs: {
      failure: { type: "object", properties, required: REPORT_SCHEMA.$defs.failure.required.filter((k) => k !== "tool" && k !== "category") },
    },
    type: "object",
    required: ["tool", "failures"],
    properties: {
      tool: { type: "string", minLength: 1 },
      summary: { type: "string" },
      guessed: { type: "boolean" },
      failures: { type: "array", items: { $ref: "#/$defs/failure" } },
    },
  };
  const wrong = [];
  let results = 0;
  for (const name of names) {
    const text = read(name).replace(/\r\n?/g, "\n");
    for (const ex of EXTRACTORS) {
      let result = null;
      try { if (ex.detect(text)) result = ex.extract(text); } catch { continue; }
      if (!result) continue;
      results++;
      for (const problem of validate(asJson(result), contract, { strict: true })) wrong.push(`${ex.name} on ${name}: ${problem}`);
    }
  }
  assert.ok(results > 600, `only ${results} parser results checked`);
  assert.deepEqual(wrong.slice(0, 8), [], `${wrong.length} problems`);
});

test("a location that points at nothing is not reported", () => {
  // A damaged log can say `:0:0`, which no tool counting from 1 prints. A report says
  // where a failure is or says nothing; it does not pass on a place that is not one.
  const zeroed = read("flake8_fail.txt").replace(/^lint_me\.py:1:1: F401/m, "lint_me.py:0:0: F401");
  assert.notEqual(zeroed, read("flake8_fail.txt"));
  const report = reportOf(zeroed);
  assert.equal(report.tool, "flake8");
  const unused = report.failures.find((f) => f.code === "F401");
  assert.equal(unused.file, "lint_me.py");
  assert.equal("line" in unused, false);
  assert.equal("col" in unused, false);
  assert.deepEqual(problems(report), []);
});

test("everything the command line prints as JSON keeps to the schema", () => {
  const command = (text, code) => [process.execPath, "-e", `process.stdout.write(${JSON.stringify(text)}); process.exitCode = ${code}`];
  const unknown = "The operation did not complete.\nSee the attached report.\n";
  const pytest = read("pytest_fail.txt");
  const cases = [
    ["a recognised pipe", ["--json"], pytest],
    ["an unrecognised pipe", ["--json"], unknown],
    ["an empty pipe", ["--json"], ""],
    ["a failed command it cannot read", ["--json", ...command(unknown, 7)], ""],
    ["a failed command with no output", ["--json", ...command("", 9)], ""],
    ["a command that succeeded", ["--json", ...command(unknown, 0)], ""],
    ["a command that could not start", ["--json", "definitely-not-a-command-whatbroke"], ""],
    ["a truncated capture", ["--json", "--max-bytes", "1024"], "chatter\n".repeat(400) + pytest],
    ["unclustered", ["--json", "--no-cluster"], pytest],
    ["the first tracked run", ["--json", "--since-last"], pytest],
    ["the second tracked run", ["--json", "--since-last"], pytest],
    ["a wrapped log", ["--json"], read("docker_buildkit_npm_fail.txt")],
    ["two tools in one log", ["--json"], read("golangci_typecheck_fail.txt")],
  ];
  const wrong = [];
  for (const [label, args, input] of cases) {
    const r = run(args, input);
    let report;
    try { report = JSON.parse(r.stdout); } catch { wrong.push(`${label}: not JSON`); continue; }
    for (const problem of problems(report)) wrong.push(`${label}: ${problem}`);
  }
  assert.deepEqual(wrong, []);
  const tracked = JSON.parse(run(["--json", "--since-last"], pytest).stdout);
  assert.equal(tracked.since.compared, true, "the tracked runs never compared, so since was only checked empty");
  // and what it prints is the report, not a copy assembled beside it
  assert.deepEqual(JSON.parse(run(["--json"], pytest).stdout), asJson(reportOf(pytest)));
});

test("the wrapper taken off a log is named in every output", () => {
  const text = read("pytest_fail.txt").split("\n").map((line) => `api:test: ${line}`).join("\n");
  const report = reportOf(text);
  assert.equal(report.tool, "pytest");
  assert.deepEqual(report.wrappers, ["api:test: "]);
  assert.match(renderReport(report, { source: false }), /^    via api:test:$/m);
  assert.match(githubOutput(report).summary, /^via `api:test:`$/m);
  assert.deepEqual(JSON.parse(run(["--json"], text).stdout).wrappers, ["api:test: "]);
  assert.match(run(["--no-source"], text).stdout, /^    via api:test:$/m);
  // one layer inside another is named outermost first
  const stacked = read("docker_buildkit_pytest_fail.txt").split("\n").map((line) => `api:test: ${line}`).join("\n");
  const layers = reportOf(stacked);
  assert.equal(layers.tool, "pytest");
  assert.equal(layers.wrappers[0], "api:test: ");
  assert.ok(layers.wrappers.length >= 2, JSON.stringify(layers.wrappers));
  assert.match(renderReport(layers, { source: false }), /^    via api:test: › /m);
  // and a log nothing was taken off names nothing
  const plain = reportOf(read("pytest_fail.txt"));
  assert.deepEqual(plain.wrappers, []);
  assert.doesNotMatch(renderReport(plain, { source: false }), /^    via /m);
  assert.doesNotMatch(githubOutput(plain).summary, /^via /m);
});

rmSync(cache, { recursive: true, force: true });
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
