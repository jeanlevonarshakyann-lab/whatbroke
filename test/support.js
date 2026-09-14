// What whatbroke reads, and what stands behind each claim that it does.
//
// The README's table says which tools whatbroke reads and what you get from each: a row
// is a promise, a parser is the code that keeps it, and a fixture is a real capture it is
// kept against. test/support.json says which rows each parser answers for. This holds the
// three to each other - no parser without a row, no row without a parser, no capture that
// no test reads - and test/detectors.js holds each parser to reading a capture of its own.
// CONTRIBUTING lists the rest of what admits a tool.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EXTRACTORS } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const support = JSON.parse(readFileSync(join(here, "support.json"), "utf8"));
const readme = readFileSync(join(here, "..", "README.md"), "utf8").replace(/\r\n?/g, "\n");

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
};

// The table under "What it reads": a row's name is its first cell, in bold - or in italics
// for the one that is not a tool, "anything else".
const start = readme.indexOf("\n## What it reads\n");
const table = readme.slice(start, readme.indexOf("\n## ", start + 1));
const rows = [...table.matchAll(/^\| (?:\*\*(.+?)\*\*|\*(.+?)\*)/gm)].map((m) => m[1] ?? m[2]);
const parsers = EXTRACTORS.map((ex) => ex.name);

console.log("\nwhat it reads");

test("the README's table is where the rows are read from", () => {
  assert.ok(start >= 0, "no \"What it reads\" section");
  assert.ok(rows.length > 100, `only ${rows.length} rows read from the table`);
  assert.equal(new Set(rows).size, rows.length, "two rows have the same name");
});

test("every parser answers for a row of the table, and every row is some parser's", () => {
  const problems = [];
  for (const name of parsers) if (!support.parsers[name]?.length) problems.push(`${name} answers for no row`);
  for (const name of Object.keys(support.parsers)) if (!parsers.includes(name)) problems.push(`${name} is not a parser`);
  for (const [name, named] of Object.entries(support.parsers)) {
    for (const row of named) if (!rows.includes(row)) problems.push(`${name} answers for "${row}", which is not a row`);
  }
  const answered = new Set(Object.values(support.parsers).flat());
  for (const row of rows) {
    if (!answered.has(row) && !support["rows without a parser"][row]) problems.push(`no parser answers for "${row}"`);
  }
  for (const row of Object.keys(support["rows without a parser"])) {
    if (!rows.includes(row)) problems.push(`"${row}" is excused but is not a row`);
    if (answered.has(row)) problems.push(`"${row}" is excused but a parser answers for it`);
  }
  assert.deepEqual(problems, []);
});

// See src/router.js: a parser is asked about a log only when the log holds one of its
// signals, and one that declares none is asked about every log, which is what keeps a
// large log slow. The two that cannot declare any say why in test/support.json.
test("every parser names the strings a log has to hold for it, or says why it cannot", () => {
  const excused = support["parsers without signals"];
  const problems = [];
  for (const ex of EXTRACTORS) {
    const has = Array.isArray(ex.signals) && ex.signals.length > 0 && ex.signals.every((s) => typeof s === "string" && s && !s.includes("\n"));
    if (!has && !excused[ex.name]) problems.push(`${ex.name} names no signals`);
    if (has && excused[ex.name]) problems.push(`${ex.name} is excused but names signals`);
  }
  for (const name of Object.keys(excused)) if (!parsers.includes(name)) problems.push(`${name} is excused but is not a parser`);
  assert.deepEqual(problems, []);
});

// A capture nothing reads is a claim nothing checks. A case names its fixture, and so does
// every check that reads one - by its whole name, so that this can find it.
test("every capture in test/fixtures is read by a test", () => {
  const scripts = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? (entry.name === "fixtures" ? [] : scripts(join(dir, entry.name)))
      : entry.name.endsWith(".js") ? [join(dir, entry.name)] : []);
  const sources = scripts(here).map((file) => readFileSync(file, "utf8"));
  const named = (fixture) => sources.some((source) => source.includes(`"${fixture}"`) || source.includes(`'${fixture}'`));
  const fixtures = readdirSync(join(here, "fixtures"));
  assert.ok(fixtures.length > 400, `only ${fixtures.length} fixtures`);
  assert.deepEqual(fixtures.filter((fixture) => !named(fixture)), []);
});

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
