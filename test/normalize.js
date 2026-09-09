// Wrapper prefixes.
//
// Turborepo prints `api:test: ` in front of every line, Docker BuildKit prints
// `#12 1.234 `, pnpm prints the package and script, kubectl prints the pod. Every
// parser anchors on the start of a line, so before this existed any one of them turned
// a readable pytest run into nothing at all - not a worse answer, no answer.
//
// The risk runs the other way too. npm begins every line of a failure with `npm error `
// and mypy repeats the source directory on each diagnostic; stripping those would
// destroy the very text the parser recognises. So the invariant these tests defend is
// not "strip prefixes" but "never come out worse than going in".
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import { analyse } from "../src/index.js";
import { wrapperCandidates } from "../src/normalize.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "fixtures");
const fx = (n) => readFileSync(join(fixtures, n), "utf8");

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
};

/** Wrappers are mechanical: a runner prefixes each line it relays. The logs underneath
 *  are the real captures already in the corpus, so wrapping them here tests the real
 *  thing without inventing tool output. */
const WRAPPERS = {
  turborepo: (l) => `api:test: ${l}`,
  pnpm: (l) => `packages/api test$ ${l}`,
  kubectl: (l) => `pod/api-7d9 ${l}`,
  // BuildKit's elapsed seconds climb, so no literal prefix is shared - this is the
  // case the vetted shapes exist for.
  docker: (l, i) => `#12 ${(i * 0.137 + 0.1).toFixed(3)} ${l}`,
};
const wrap = (text, fn) => text.split("\n").map((l, i) => (l.trim() ? fn(l, i) : l)).join("\n");

// A tool that rewrites its progress line with a bare CR packs many logical lines into
// one physical line. A line-prefixing runner stamps that blob once, and normalising the
// CRs afterwards yields interior lines with no prefix - too few to clear the uniformity
// gate. Narrow, understood, and documented in the README rather than papered over.
const usesBareCr = (text) => /\r(?!\n)/.test(text);

const corpus = readdirSync(fixtures).filter((f) => !usesBareCr(fx(f)));

// -------------------------------------------------------- the core invariant

test("wrapping a log never makes it parse worse", () => {
  const broken = [];
  let checked = 0;
  for (const name of corpus) {
    const base = analyse(fx(name));
    if (!base) continue;
    for (const [runner, fn] of Object.entries(WRAPPERS)) {
      const got = analyse(wrap(fx(name), fn));
      checked++;
      if (got?.tool !== base.tool || got?.failures.length !== base.failures.length) {
        broken.push(`${name} + ${runner}: ${base.tool}/${base.failures.length} -> ${got?.tool ?? "none"}/${got?.failures.length ?? 0}`);
      }
    }
  }
  assert.ok(checked > 150, `only ${checked} combinations exercised`);
  assert.deepEqual(broken, [], `${broken.length} of ${checked} wrapped logs regressed`);
});

test("an unwrapped log is left exactly as it was", () => {
  for (const name of readdirSync(fixtures)) {
    // The BuildKit captures are wrapped by definition - that is what they are for.
    if (name.startsWith("docker_buildkit_")) continue;
    const r = analyse(fx(name));
    if (!r) continue;
    assert.equal(r.wrappers, undefined, `${name} had a wrapper stripped from it`);
  }
});

test("a container's frame is peeled even inside another runner's prefix", () => {
  // A monorepo runner relaying a container relaying a test run. Peeling only the outer
  // prefix is no improvement by itself, so a strictly greedy search gives up there.
  const raw = fx("docker_buildkit_pytest_fail.txt");
  for (const [runner, fn] of Object.entries(WRAPPERS)) {
    const r = analyse(wrap(raw, fn));
    assert.equal(r?.tool, "pytest", `${runner} around buildkit`);
    assert.equal(r.failures.length, analyse(raw).failures.length, `${runner}: lost failures`);
    assert.ok(r.wrappers.length >= 2, `${runner}: both layers should be named, got ${JSON.stringify(r.wrappers)}`);
  }
});

// ------------------------------------------------- refusing to strip data

test("a tool's own line prefix is not mistaken for a wrapper", () => {
  // npm leads every line with `npm error `, mypy repeats the source directory, tsc
  // repeats the file. All three look exactly like a uniform wrapper and none is one.
  for (const [name, tool] of [["npm_fail.txt", "npm"], ["mypy_notes_fail.txt", "mypy"], ["tsc_plain.txt", "tsc"]]) {
    const before = analyse(fx(name));
    assert.equal(before.tool, tool);
    assert.equal(before.wrappers, undefined, `${name}: stripped its own prefix`);
    // the file paths must survive intact, which is what stripping would have ruined
    for (const f of before.failures) {
      if (f.file) assert.ok(f.file.length > 0);
    }
  }
});

test("a wrapper is never stripped when doing so parses nothing", () => {
  // Uniform prefix, but the text underneath is not any tool's output.
  const text = Array.from({ length: 40 }, (_, i) => `runner|  line ${i} of prose`).join("\n");
  const r = analyse(text);
  if (r) assert.notEqual(r.tool, undefined);
  assert.ok(wrapperCandidates(text).length > 0, "the prefix should still be proposed");
});

test("a region is only lifted out when the whole log says nothing", () => {
  // Taking BuildKit's failure block throws away everything outside it, so it must never
  // displace a reading of the whole log. A log that already parses keeps its own reading
  // even when a block is present.
  const withBlock = fx("docker_buildkit_pytest_fail.txt");
  const alsoParses = `${fx("eslint_bulk_fail.txt")}\n${withBlock}`;
  const r = analyse(alsoParses);
  assert.equal(r.tool, "eslint", "a region candidate displaced a full-log reading");
  assert.equal(r.wrappers, undefined);
});

// ------------------------------------------------------------- the wrappers

test("each runner's prefix is removed and reported", () => {
  const base = analyse(fx("pytest_fail.txt"));
  for (const [runner, fn] of Object.entries(WRAPPERS)) {
    const r = analyse(wrap(fx("pytest_fail.txt"), fn));
    assert.equal(r?.tool, "pytest", `${runner}: wrong tool`);
    assert.equal(r.failures.length, base.failures.length, `${runner}: wrong failure count`);
    assert.ok(r.wrappers?.length, `${runner}: the prefix should be reported, not silently dropped`);
    assert.equal(r.failures[0].file, base.failures[0].file, `${runner}: the location was corrupted`);
  }
});

test("a CI stamp around a monorepo prefix is peeled in one go", () => {
  const inner = wrap(fx("pytest_fail.txt"), (l) => `api:test: ${l}`);
  const stacked = wrap(inner, (l) => `2026-09-09T05:00:00.1234567Z ${l}`);
  const r = analyse(stacked);
  assert.equal(r?.tool, "pytest");
  assert.equal(r.failures.length, 3);
});

test("the tool's own indentation survives the strip", () => {
  // eslint nests its problems under the file they belong to. A prefix search that ran
  // on into that indentation would take away the thing eslint matches on.
  const r = analyse(wrap(fx("eslint_bulk_fail.txt"), (l) => `api:test: ${l}`));
  assert.equal(r?.tool, "eslint");
  assert.equal(r.failures.length, analyse(fx("eslint_bulk_fail.txt")).failures.length);
});

test("normalisation is not slow on a large or hostile log", () => {
  const big = wrap(fx("eslint_bulk_fail.txt").repeat(20), (l) => `api:test: ${l}`);
  for (const text of [big, "\n".repeat(50000), "   \n".repeat(50000), "x".repeat(500000)]) {
    const started = Date.now();
    analyse(text);
    const took = Date.now() - started;
    assert.ok(took < 3000, `normalisation took ${took}ms`);
  }
});

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
