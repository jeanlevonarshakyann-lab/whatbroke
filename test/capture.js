// Capture has one job that outranks the rest: whatever gets dropped, the part of the
// log that says why the command failed has to survive. That part is at the END almost
// every time - pytest's summary, cargo's error, the stack trace - so these tests care
// most about what happens when the budget runs out long before the output does.
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { createCapture, elision } from "../src/capture.js";
import { analyse, EXTRACTORS } from "../src/index.js";

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

/** Feed text through the accumulator, optionally in chunks of a given size. */
function capture(text, maxBytes, chunk = 0) {
  const c = createCapture(maxBytes);
  const buf = Buffer.from(text, "utf8");
  if (!chunk) c.push(buf);
  else for (let i = 0; i < buf.length; i += chunk) c.push(buf.subarray(i, i + chunk));
  return c.finish();
}

const MARKER = /\n~~~ whatbroke: \d+ bytes of output elided here[^\n]*~~~\n/g;

// ------------------------------------------------------------- under the cap

test("output that fits is returned byte for byte", () => {
  const text = fx("pytest_fail.txt");
  const r = capture(text, 10 * 1024 * 1024);
  assert.equal(r.truncated, false);
  assert.equal(r.text, text, "an ordinary run must be completely unaffected");
  assert.equal(r.elided, 0);
});

test("chunk boundaries do not change the result", () => {
  const text = fx("eslint_bulk_fail.txt");
  for (const size of [1, 7, 64, 4096]) {
    assert.equal(capture(text, 10 * 1024 * 1024, size).text, text, `chunked by ${size}`);
  }
});

// -------------------------------------------------------------- over the cap

test("the end of the log survives the cap", () => {
  const tail = fx("pytest_fail.txt");
  const r = capture("filler that means nothing\n".repeat(60000) + tail, 100000);
  assert.equal(r.truncated, true);
  assert.ok(r.text.endsWith(tail.slice(-200)), "the last bytes of the log must be kept");
  assert.match(r.text, MARKER);
});

test("the beginning of the log is kept too", () => {
  const r = capture("FIRST_LINE_MATTERS\n" + "x\n".repeat(200000) + "LAST_LINE\n", 10000);
  assert.match(r.text, /^FIRST_LINE_MATTERS\n/, "the command and its banner live at the top");
  assert.match(r.text, /LAST_LINE\n$/);
});

test("a failure at the end is still diagnosed, not lost", () => {
  const dir = mkdtempSync(join(tmpdir(), "wb-cap-"));
  try {
    const log = join(dir, "big.log");
    writeFileSync(log, "filler that means nothing\n".repeat(60000) + fx("pytest_fail.txt"));
    const r = spawnSync(process.execPath, [cli, "--json", "--max-bytes", "100000"], {
      input: readFileSync(log, "utf8"), encoding: "utf8",
    });
    const out = JSON.parse(r.stdout);
    assert.equal(out.tool, "pytest", "the parser must still recognise the tool");
    assert.equal(out.failures.length, 3);
    assert.equal(out.truncated, true, "and the run must still declare it was truncated");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a diagnostic in the middle survives clean output on both sides", () => {
  const failure = fx("pytest_fail.txt");
  const text = "build started\n"
    + "ordinary compiler output\n".repeat(5000)
    + failure
    + "cleanup completed\n".repeat(10000);
  const r = capture(text, 32768);
  for (const chunk of [7, 4096]) {
    assert.deepEqual(capture(text, 32768, chunk), r, `capture changed at chunk size ${chunk}`);
  }
  const parsed = analyse(r.text);
  assert.equal(r.truncated, true);
  assert.equal(parsed?.tool, "pytest", "the middle diagnostic must still reach its parser");
  assert.equal(parsed?.failures.length, 3);
  assert.match(r.text, /cleanup completed\n$/, "the tail remains available for shutdown errors");
  const gaps = [...r.text.matchAll(/whatbroke: (\d+) bytes of output elided here/g)];
  assert.ok(gaps.length >= 2, "separate missing regions must remain visibly separate");
  assert.equal(gaps.reduce((sum, match) => sum + Number(match[1]), 0), r.elided);
  assert.equal(r.elided + Buffer.byteLength(r.text.replace(MARKER, "")), Buffer.byteLength(text));
});

test("diagnostics already in the tail do not spend the capture budget twice", () => {
  const max = 20000;
  const r = capture("ordinary output\n".repeat(20000) + fx("pytest_fail.txt"), max, 997);
  const payload = Buffer.byteLength(r.text.replace(MARKER, ""));
  assert.ok(payload > max - 100, `only ${payload} of ${max} available bytes were used`);
  assert.equal(analyse(r.text)?.failures.length, 3);
});

test("the capture stays within its budget", () => {
  const r = capture("y\n".repeat(500000), 8192);
  const payload = r.text.replace(MARKER, "");
  assert.ok(Buffer.byteLength(payload) <= 8192, `kept ${Buffer.byteLength(payload)} bytes`);
});

// -------------------------------------------------------------- cut quality

test("cuts land on line boundaries, never mid-line", () => {
  const line = (n) => `line ${String(n).padStart(6, "0")} of the log\n`;
  let text = "";
  for (let i = 0; i < 100000; i++) text += line(i);
  const r = capture(text, 20000);
  for (const part of r.text.split(MARKER)) {
    for (const l of part.split("\n")) {
      if (l === "") continue;
      assert.match(l, /^line \d{6} of the log$/, `severed line: ${JSON.stringify(l)}`);
    }
  }
});

test("multi-byte characters are never split", () => {
  // A run of 3-byte characters straddling every plausible cut point.
  const text = "x".repeat(2040) + "日本語テスト日本語\n" + "y".repeat(4000) + "\n語末\n";
  for (let max = 1024; max <= 4100; max += 37) {
    const r = capture(text, max);
    assert.ok(!r.text.includes("�"), `replacement character at --max-bytes ${max}`);
  }
});

test("output with no newline at all is still cut safely", () => {
  const r = capture("語".repeat(4000), 1024);   // one line, all multi-byte
  assert.equal(r.truncated, true);
  assert.ok(!r.text.includes("�"), "a cut with no newline to aim for still must not split");
  assert.match(r.text, MARKER);
});

// ------------------------------------------------------------ the marker

test("the marker declares how much went missing", () => {
  const r = capture("z\n".repeat(100000), 5000);
  const said = Number(r.text.match(/whatbroke: (\d+) bytes/)[1]);
  assert.equal(said, r.elided);
  const kept = Buffer.byteLength(r.text.replace(MARKER, ""));
  assert.equal(said + kept, 200000, "elided plus kept must account for the whole input");
});

test("the marker can never be reported as a failure", () => {
  const m = elision(123456);
  for (const ex of EXTRACTORS) {
    let failures = [];
    try { if (ex.detect(m)) failures = ex.extract(m)?.failures ?? []; } catch { /* covered elsewhere */ }
    assert.equal(failures.length, 0, `${ex.name} turned the elision marker into a failure`);
  }
  // and spliced into a real log it must not disturb the diagnosis
  const real = fx("pytest_fail.txt");
  const r = analyse(real.slice(0, 200) + m + real.slice(200));
  assert.equal(r.tool, "pytest");
  assert.equal(r.failures.filter((f) => JSON.stringify(f).includes("elided")).length, 0);
});

// ------------------------------------------- the failure has to survive the cap

// The whole point of keeping windows in the middle is that a real failure cannot vanish
// because cleanup output followed it. Burying each captured fixture in three megabytes
// of build chatter and capping the result lost the diagnosis in 25 of 124 - six of them
// completely, to no diagnosis at all - and the cap size made no difference, because what
// decides is which lines the scan calls probable, not how much room there is.
//
// Three kinds of narrowness did it, and they are worth naming because the temptation is
// to widen by feel: a leading \b cannot match "KeyError" or "SyntaxError"; "panic" with
// a trailing \b does not match "panicked"; and some tools write no failure word at all,
// so a location's shape has to stand in for one. Colour codes hid the rest - deno writes
// "\x1b[31merror\x1b[0m:", where the "m" ending the escape sits against the "e".
test("a buried failure survives the cap, whatever tool wrote it", () => {
  const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

  const line = "  vite:build transforming src/components/Widget.tsx +2ms\n";
  const noise = (bytes) => line.repeat(Math.ceil(bytes / line.length));
  const head = noise(1_500_000), tail = noise(1_500_000);

  const lost = [];
  let checked = 0;
  for (const name of readdirSync(fixtures)) {
    const raw = readFileSync(join(fixtures, name), "utf8");
    let plain;
    try { plain = analyse(raw); } catch { continue; }
    if (!plain?.failures.length) continue;
    checked++;

    const c = createCapture(120_000);
    c.push(Buffer.from(head, "utf8"));
    c.push(Buffer.from(`${raw}\n`, "utf8"));
    c.push(Buffer.from(tail, "utf8"));
    const kept = c.finish();
    const text = typeof kept === "string" ? kept : kept.text;

    let got = null;
    try { got = analyse(text); } catch { got = null; }
    // The tool must still be the tool. How many of its failures survive is a budget
    // question; losing the diagnosis entirely, or handing it to the guess, is not.
    if (got?.tool !== plain.tool) {
      lost.push(`${name}: ${plain.tool}/${plain.failures.length} -> ${got?.tool ?? "none"}/${got?.failures.length ?? 0}`);
    }
  }
  assert.ok(checked > 100, `only ${checked} fixtures buried`);
  assert.deepEqual(lost.slice(0, 8), [], "a real failure disappeared under cleanup output");
  console.log(`       ${checked} fixtures buried in 3MB of chatter and capped to 120KB`);
});

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
