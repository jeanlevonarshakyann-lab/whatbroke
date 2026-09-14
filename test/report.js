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
import { evidenced } from "./evidenced.js";
import { createCapture } from "../src/capture.js";
import { stripAnsi } from "../src/util.js";
import { sourceRange } from "../src/ownership.js";

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
    "evidence on line 0": (r) => { r.failures[0].evidence = [{ start: 0, end: 1 }]; },
    "evidence with no end": (r) => { r.failures[0].evidence = [{ start: 3 }]; },
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
// report documents and nothing else, less what the reader adds - the tool's name and the
// evidence on each failure, and the category a parser need not state when it is its own.
test("every parser's own result keeps to what a report is built from", () => {
  const { tool, evidence, ...properties } = REPORT_SCHEMA.$defs.failure.properties;
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

// Every failure says which lines of the output it was read from. What a parser was given
// is not the output: colour, a CI stamp and a runner's prefix are gone from the front of
// its lines, a retried run is one copy, a progress bar's redraws are lines of their own,
// and BuildKit's failing steps may be all that is left of a build. None of that may move
// the numbers, and a capture cut short must not either.
const evidenceOf = (report) => [...report.failures, ...(report.others ?? []).flatMap((o) => o.failures)]
  .map((f) => JSON.stringify(f.evidence));

test("every failure's evidence is the lines of the output it was read from", () => {
  const wrong = [];
  let failures = 0;
  for (const name of names) {
    const text = read(name);
    const analysis = analyse(text);
    const report = createReport({ analysis, raw: text, exitCode: 0, inputMode: "pipe" });
    const lines = stripAnsi(text).split("\n");
    const readings = analysis ? [...analysis.failures, ...(analysis.others ?? []).flatMap((o) => o.failures)] : [];
    for (const [i, f] of [...report.failures, ...(report.others ?? []).flatMap((o) => o.failures)].entries()) {
      failures++;
      // Where nothing was taken out of the log or broken in two, the evidence is every place
      // the failure was read from, one line further on - the first and all the others.
      if (!text.includes("\r") && !report.wrappers.length) {
        const range = sourceRange(readings[i]);
        const places = [range, ...(range.also ?? [])].map(({ start, end }) => ({ start: start + 1, end }))
          .sort((a, b) => a.start - b.start)
          .reduce((apart, p) => {
            const last = apart.at(-1);
            if (last && p.start <= last.end + 1) last.end = Math.max(last.end, p.end);
            else apart.push({ ...p });
            return apart;
          }, []);
        if (JSON.stringify(f.evidence) !== JSON.stringify(places)) wrong.push(`${name}: ${JSON.stringify(f.evidence)} for places ${JSON.stringify(places)}`);
      }
      const said = f.evidence.flatMap(({ start, end }) => lines.slice(start - 1, end));
      if (f.evidence.some(({ end }) => end > lines.length)) wrong.push(`${name}: ${JSON.stringify(f.evidence)} of ${lines.length} lines`);
      else if (!evidenced(f, said, { start: 0, end: said.length })) {
        wrong.push(`${name}: lines ${JSON.stringify(f.evidence)} say nothing of ${JSON.stringify([f.file, f.code, f.message])}`);
      }
    }
  }
  assert.ok(failures > 1000, `only ${failures} failures checked`);
  assert.deepEqual(wrong.slice(0, 8), [], `${wrong.length} failures`);
});

test("what is done to a log before it is read does not move its evidence", () => {
  const E = String.fromCharCode(27), CR = String.fromCharCode(13);
  const dressed = {
    "with CRLF line endings": (t) => t.replace(/\n/g, CR + "\n"),
    "coloured": (t) => t.split("\n").map((l) => (l ? `${E}[31m${l}${E}[0m` : l)).join("\n"),
    "stamped by CI": (t) => t.split("\n").map((l) => `2026-09-14T10:00:00.1234567Z ${l}`).join("\n"),
    "prefixed by a monorepo runner": (t) => t.split("\n").map((l) => `api:test: ${l}`).join("\n"),
    "retried, word for word": (t) => (t.endsWith("\n") ? `${t}${t}` : `${t}\n${t}`),
  };
  // Where the parser read each failure, in the text it was given. When a dressed log is read
  // from the same lines of that text as the log as written, its evidence has to be the same
  // lines of the output - and when it is not, something else changed what was read.
  const placesRead = (analysis) => JSON.stringify([...analysis.failures, ...(analysis.others ?? []).flatMap((o) => o.failures)]
    .map((f) => sourceRange(f)));
  const wrong = [];
  let compared = 0;
  for (const name of names.filter((n) => !n.startsWith("docker_buildkit_"))) {
    const text = read(name);
    if (text.includes(CR) || text.includes(E)) continue;
    const analysis = analyse(text);
    if (!analysis) continue;
    const plain = createReport({ analysis, raw: text, exitCode: 0, inputMode: "pipe" });
    for (const [how, dress] of Object.entries(dressed)) {
      const again = analyse(dress(text));
      // a dressing that changes what is read is test/normalize.js's business, not this one's
      if (!again || placesRead(again) !== placesRead(analysis)) continue;
      const report = createReport({ analysis: again, raw: dress(text), exitCode: 0, inputMode: "pipe" });
      compared++;
      if (JSON.stringify(evidenceOf(report)) !== JSON.stringify(evidenceOf(plain))) {
        wrong.push(`${name} ${how}: ${evidenceOf(report)[0]} where the log as written says ${evidenceOf(plain)[0]}`);
      }
    }
  }
  assert.ok(compared > 1000, `only ${compared} dressed logs compared`);
  assert.deepEqual(wrong.slice(0, 8), [], `${wrong.length} logs`);
});

test("a progress bar's redraws are one line of the output, however many a parser sees", () => {
  const CR = String.fromCharCode(13);
  const text = read("pytest_fail.txt");
  const redrawn = `Collecting 10%${CR}Collecting 50%${CR}Collecting 100%\n${text}`;
  const shifted = evidenceOf(reportOf(text)).map((e) => JSON.stringify(JSON.parse(e).map(({ start, end }) => ({ start: start + 1, end: end + 1 }))));
  assert.deepEqual(evidenceOf(reportOf(redrawn)), shifted);
});

test("evidence read from BuildKit's failing steps is where those steps are in the build", () => {
  // Without its stamped output the build is only the steps Docker quotes when it fails,
  // which is lifted out of the log and read on its own.
  const all = read("docker_buildkit_pytest_fail.txt").split("\n");
  const quoted = [...all.slice(0, 64), ...all.slice(88)].join("\n");
  const report = reportOf(quoted);
  assert.ok(report.wrappers.includes("docker buildkit"), JSON.stringify(report.wrappers));
  const lines = quoted.split("\n");
  for (const f of report.failures) {
    const said = f.evidence.flatMap(({ start, end }) => lines.slice(start - 1, end));
    assert.ok(said.length && evidenced(f, said, { start: 0, end: said.length }), `${f.title}: ${JSON.stringify(f.evidence)}`);
    assert.ok(f.evidence.every(({ start }) => start > 64), "evidence outside the quoted steps");
  }
});

test("a capture cut short still numbers the output's lines, not its own", () => {
  const text = read("pytest_fail.txt");
  const chatter = Array.from({ length: 4000 }, (_, i) => `building module ${i} of 4000`).join("\n");
  const output = `${chatter}\n${text}`;
  const capture = createCapture(16 * 1024);
  capture.push(Buffer.from(output));
  const { text: captured, truncated, lines } = capture.finish();
  assert.equal(truncated, true);
  const report = createReport({ analysis: analyse(captured), raw: captured, exitCode: 0, inputMode: "pipe", truncated, lines });
  const expected = evidenceOf(reportOf(text)).map((e) => JSON.stringify(JSON.parse(e).map(({ start, end }) => ({ start: start + 4000, end: end + 4000 }))));
  assert.deepEqual(evidenceOf(report), expected);
  // and the same through the command line, reading a pipe
  const cli = JSON.parse(run(["--json", "--max-bytes", String(16 * 1024)], output).stdout);
  assert.equal(cli.truncated, true);
  assert.deepEqual(evidenceOf(cli), expected);
});

test("a control sequence cut off before its end does not take the lines after it", () => {
  // A window title half written, and a bell three lines later: everything between used to
  // be read as the title, a diagnostic with it.
  const E = String.fromCharCode(27), BEL = String.fromCharCode(7);
  const text = read("flake8_fail.txt").split("\n");
  const damaged = [`${E}]0;flake8 running`, ...text.slice(0, 2), `${BEL}${text[2]}`, ...text.slice(3)].join("\n");
  const report = reportOf(damaged);
  const plain = reportOf(text.join("\n"));
  assert.equal(report.tool, "flake8");
  assert.equal(report.failures.length, plain.failures.length);
  assert.deepEqual(evidenceOf(report), evidenceOf(plain).map((e) => JSON.stringify(JSON.parse(e).map(({ start, end }) => ({ start: start + 1, end: end + 1 })))));
});

rmSync(cache, { recursive: true, force: true });
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
