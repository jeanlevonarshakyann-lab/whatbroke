// What every file in test/tools/ shares: where the fixtures and the command line are, and the
// two loops that hold a family's fixtures to what they have to read.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import { analyse } from "../../src/index.js";

export const here = join(dirname(fileURLToPath(import.meta.url)), "..");
export const fx = (n) => readFileSync(join(here, "fixtures", n), "utf8");
export const cli = join(here, "..", "bin", "whyitbroke.js");

/** Each case names a fixture, the tool that has to read it and how many failures it holds,
 *  and checks what else has to be true of the reading. */
export function runCases(CASES) {
  let pass = 0, fail = 0;
  for (const c of CASES) {
    try {
      const r = analyse(fx(c.file));
      assert.ok(r, `${c.file}: nothing extracted`);
      assert.equal(r.tool, c.tool, `${c.file}: wrong tool`);
      assert.equal(r.failures.length, c.n, `${c.file}: expected ${c.n} failures, got ${r.failures.length}`);
      c.check(r);
      console.log(`  ok   ${c.file}  (${r.tool}, ${r.failures.length} failures)`);
      pass++;
    } catch (e) {
      console.log(`  FAIL ${c.file}\n       ${e.message}`);
      fail++;
    }
  }
  return { pass, fail };
}

// A tool's --format flag changes how a run is printed, not what happened in it. So two
// captures of ONE run, taken in two formats, have to arrive at the same failures - and
// the way these parsers broke was always the same shape: one format was read, the others
// silently gave less. Comparing the formats against each other is what catches that,
// because each capture on its own looks perfectly plausible.
// A format may legitimately print less than another - pylint's -f parseable and -f msvs
// carry no column at all - and a field the tool never printed is the format speaking,
// not the parser guessing. Those are named per group; everything else has to match.
export function agreeAcrossFormats(groups) {
  let pass = 0, fail = 0;
  for (const [group, encodings, silentAbout = []] of groups) {
    try {
      // The path is the other legitimate difference: a formatter that writes a machine
      // format writes the absolute path, and the one that writes a table writes the path
      // you typed.
      const said = (name) => analyse(fx(name)).failures
        .map((f) => JSON.stringify(["file", "line", "col", "code", "subject", "message"]
          .filter((k) => !silentAbout.includes(k))
          .map((k) => (k === "file" ? f.file?.split("/").pop() ?? null : f[k] ?? null))))
        .sort();
      const first = said(encodings[0]);
      assert.ok(first.length > 0, `${encodings[0]}: nothing extracted`);
      for (const other of encodings.slice(1)) {
        assert.deepEqual(said(other), first, `${group}: ${other} disagrees with ${encodings[0]}`);
      }
      // ...and a named silence is a claim about the format, not a licence to lose the
      // field everywhere: whatever else the group agrees on, one encoding still has it.
      for (const k of silentAbout) {
        assert.ok(encodings.some((n) => analyse(fx(n)).failures.some((f) => f[k] !== undefined)),
          `${group}: no encoding carries ${k}, so it is not a per-format difference`);
      }
      console.log(`  ok   ${group}: ${encodings.length} formats of one run agree (${first.length} failures)`);
      pass++;
    } catch (e) {
      console.log(`  FAIL ${group} formats\n       ${e.message}`);
      fail++;
    }
  }
  return { pass, fail };
}
