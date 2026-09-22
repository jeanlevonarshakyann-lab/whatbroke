// How long reading takes: `npm run bench`.
//
// Logs of three sizes, each of a kind whyitbroke meets: build output nothing reads, a
// failure at the start of it or at the end, a large lint run, a large test run, every
// log in the corpus at once, and a shape that used to take time growing as its square.
// Every line differs from the ones around it, because a log that repeats itself exactly
// is collapsed as a retry before any parser sees it and would measure nothing.
//
// Each is read three times and the fastest is printed. Nothing here is a test: times
// depend on the machine, and test/bounds.js holds growth to account without a clock.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyse } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "..", "test", "fixtures");
const fx = (name) => readFileSync(join(fixtures, name), "utf8");

const KiB = 1024, MiB = 1024 * KiB;
const SIZES = [["100 KB", 100 * KiB], ["1 MiB", MiB], ["10 MiB", 10 * MiB]];

/** Lines from `line(i)` until the text is `bytes` long. */
function lines(bytes, line) {
  const out = [];
  for (let size = 0, i = 0; size < bytes; i++) {
    const text = line(i);
    out.push(text);
    size += text.length + 1;
  }
  return out.join("\n");
}
const chatter = (bytes) => lines(bytes, (i) => `  vite:build transforming src/components/Widget${i}.tsx +${i % 97}ms`);
// A real capture, over and over, each copy told apart by a line of its own.
const numbered = (text) => (bytes) => lines(bytes, (i) => `${text}\n[copy ${i}]`);

const KINDS = [
  ["build output nothing reads", chatter],
  ["a jest failure, then build output", (bytes) => `${fx("jest_fail.txt")}\n${chatter(bytes)}`],
  ["build output, then a jest failure", (bytes) => `${chatter(bytes)}\n${fx("jest_fail.txt")}`],
  ["an eslint run", numbered(fx("eslint_bulk_fail.txt"))],
  ["a pytest run", numbered(fx("pytest_fail.txt"))],
  ["every log in the corpus", numbered(readdirSync(fixtures).sort().map(fx).join("\n"))],
  ["lines that each open a brace", (bytes) => lines(bytes, (i) => `{ "step": ${i}`)],
];

analyse(fx("pytest_fail.txt"));   // compiling belongs to nobody's row
const pad = (text, width) => String(text).padEnd(width);
console.log(`${pad("log", 36)}${SIZES.map(([label]) => pad(label, 12)).join("")}`);
for (const [kind, make] of KINDS) {
  const cells = [];
  for (const [, bytes] of SIZES) {
    const text = make(bytes);
    let best = Infinity, found = 0;
    for (let run = 0; run < 3; run++) {
      const at = performance.now();
      const r = analyse(text);
      best = Math.min(best, performance.now() - at);
      found = (r?.failures.length ?? 0) + (r?.others ?? []).reduce((n, o) => n + o.failures.length, 0);
    }
    cells.push(pad(`${best < 10 ? best.toFixed(1) : Math.round(best)} ms`, 12));
    void found;
  }
  console.log(`${pad(kind, 36)}${cells.join("")}`);
}
