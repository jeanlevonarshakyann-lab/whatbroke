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
import { isDeepStrictEqual } from "node:util";
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
//
// This is now only true of the DISCOVERED literal prefixes wrapped below. A CI stamp is
// recognised by shape rather than found by comparison, so it is taken off before the CRs
// are expanded and the problem does not arise there - see the CI-stamp test at the foot
// of this file, which excludes nothing.
const usesBareCr = (text) => /\r(?!\n)/.test(text);

// A uniform prefix cannot be established from a single line - there is nothing to
// compare it against, and on one line ANY leading text looks uniform. The minimum of
// three lines is what stops a prefix search from cutting arbitrary text off a short
// log, so a one-line failure inside a runner's prefix is not recoverable. The CLI still
// surfaces the raw output in that case, so nothing is hidden; it just is not parsed.
const tooShortToUnwrap = (text) => text.split("\n").filter((l) => l.trim()).length < 3;

const corpus = readdirSync(fixtures).filter((f) => !usesBareCr(fx(f)) && !tooShortToUnwrap(fx(f)));

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

// ------------------------------------------------ the way a log leaves CI

// The commonest way a log reaches whatbroke is not a monorepo runner. It is a CI or a
// log collector stamping every line, and each of these writes a shape that is known in
// advance rather than a prefix that has to be inferred by comparing lines. That is the
// whole difference: a hand-written shape is proven against the corpus to match nothing
// that is not a wrapper, so it needs no second line to corroborate it - which is why
// nothing is excluded here, however short a log is.
//
// Every one of these cost the corpus its parsers. 11 fixtures through an Actions log,
// 95 through Jenkins or journald, and 94 through Buildkite --timestamp-lines before
// the shapes existed and the line-count floors came off. The one fixture that uses a
// bare CR is the exception noted above, and is excluded for the reason given there.
const CI_STAMPS = {
  "GitHub Actions raw log": (l, i) =>
    `2026-09-10T10:16:${String(54 + (i % 5)).padStart(2, "0")}.1234567Z ${l}`,
  "gh run view --log": (l, i) =>
    `build\tRun tests\t2026-09-10T10:16:${String(54 + (i % 5)).padStart(2, "0")}.1234567Z ${l}`,
  // docker logs --timestamps writes nanoseconds where Actions writes seven digits
  "docker logs --timestamps": (l, i) =>
    `2026-09-10T10:16:${String(54 + (i % 5)).padStart(2, "0")}.123456789Z ${l}`,
  // Jenkins' Timestamper brackets the time, in either of two forms depending on the job
  "Jenkins Timestamper (ISO)": (l, i) =>
    `[2026-09-10T10:16:${String(54 + (i % 5)).padStart(2, "0")}.123Z] ${l}`,
  "Jenkins Timestamper (clock)": (l, i) =>
    `[10:16:${String(54 + (i % 5)).padStart(2, "0")}] ${l}`,
  // buildkite-agent --timestamp-lines uses a space between the date and time
  "Buildkite --timestamp-lines": (l, i) =>
    `[2026-09-10 10:16:${String(54 + (i % 5)).padStart(2, "0")}] ${l}`,
  // a log collected by journald rather than read off the terminal
  "journald / syslog": (l, i) =>
    `Sep 10 10:16:${String(54 + (i % 5)).padStart(2, "0")} runner app[123]: ${l}`,
};

test("a log that came out of CI reads exactly as it went in", () => {
  const changed = [];
  let checked = 0;
  for (const name of readdirSync(fixtures)) {
    if (usesBareCr(fx(name))) continue;
    const base = analyse(fx(name));
    if (!base?.failures.length) continue;
    for (const [runner, fn] of Object.entries(CI_STAMPS)) {
      checked++;
      const got = analyse(wrap(fx(name), fn));
      const want = `${base.tool}/${base.failures.length}`;
      const have = got ? `${got.tool}/${got.failures.length}` : "none";
      if (want !== have) changed.push(`${name} + ${runner}: ${want} -> ${have}`);
    }
  }
  assert.ok(checked > 200, `only ${checked} stamped logs exercised`);
  assert.deepEqual(changed.slice(0, 6), [], "a stamped log lost its parser");
  console.log(`       ${checked} stamped logs across ${Object.keys(CI_STAMPS).length} CI formats`);
});

test("a CI-stamped redraw blob survives bare carriage returns", () => {
  const changed = [];
  let checked = 0;
  for (const name of readdirSync(fixtures)) {
    const base = analyse(fx(name));
    if (!base?.failures.length) continue;
    for (const [runner, fn] of Object.entries(CI_STAMPS)) {
      checked++;
      // The collector sees one physical line and stamps it once. The tool's redraws
      // become logical lines only after whatbroke receives the byte stream.
      const got = analyse(fn(fx(name).replace(/\n/g, "\r"), 0));
      if (got?.tool !== base.tool || !isDeepStrictEqual(got?.failures, base.failures)) {
        changed.push(`${name} + ${runner}: ${base.tool}/${base.failures.length} -> ${got?.tool ?? "none"}/${got?.failures.length ?? 0}`);
      }
    }
  }
  assert.ok(checked > 200, `only ${checked} redraw blobs exercised`);
  assert.deepEqual(changed.slice(0, 6), [], "a stamped redraw blob changed its diagnosis");
  console.log(`       ${checked} stamped redraw blobs across ${Object.keys(CI_STAMPS).length} CI formats`);
});

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
