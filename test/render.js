// Rendering: what the terminal shows, the problem matcher that reads it, and the source it quotes.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { analyse } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n) => readFileSync(join(here, "fixtures", n), "utf8");
const cli = join(here, "..", "bin", "whyitbroke.js");

let pass = 0, fail = 0;


// Every field a parser sets is eventually rendered, and the renderer interpolates
// `trace` straight into text. A parser that filled it with frame objects instead of
// strings printed "at [object Object]" for every frame - and passed its own tests,
// because they asserted the array's LENGTH. Only running the CLI showed it. This sweeps
// the whole corpus so the next parser cannot repeat it.
try {
  const bad = [];
  for (const name of readdirSync(join(here, "fixtures"))) {
    let r;
    try { r = analyse(fx(name)); } catch { continue; }
    const every = [...(r?.failures ?? []), ...(r?.others ?? []).flatMap((o) => o.failures)];
    for (const f of every) {
      if (f.trace === undefined) continue;
      if (!Array.isArray(f.trace)) { bad.push(`${name} (${r.tool}): trace is ${typeof f.trace}`); continue; }
      for (const t of f.trace) {
        if (typeof t !== "string") bad.push(`${name} (${r.tool}): a trace entry is ${typeof t}, renders as "${String(t)}"`);
      }
    }
  }
  assert.deepEqual(bad, [], "a trace entry would not render as text");
  console.log("  ok   every trace entry renders as text");
  pass++;
} catch (e) {
  console.log(`  FAIL every trace entry renders as text\n       ${e.message}`);
  fail++;
}

// The renderer is exercised above with hand-built failure objects, which is why a parser
// that put the wrong SHAPE in a field went unnoticed: nothing rendered what a parser
// actually produced. This renders every fixture the way the CLI does and looks for the
// marks of a value that was interpolated without being formatted.
try {
  const { render, setColor } = await import("../src/render.js");
  setColor(false);
  const LEAKED = [
    [/\[object [A-Z]\w+\]/, "an object was interpolated into text"],
    [/\bundefined\b/, "an undefined value reached the output"],
    [/\bNaN\b/, "a number that is not one reached the output"],
    [/:null\b|\bnull:/, "a null stood in for a location"],
  ];
  const leaks = [];
  for (const name of readdirSync(join(here, "fixtures"))) {
    let r, out;
    try { r = analyse(fx(name)); } catch { continue; }
    if (!r) continue;
    try { out = render(r, {}); } catch (e) { leaks.push(`${name}: render threw - ${e.message}`); continue; }
    for (const [re, why] of LEAKED) {
      const hit = out.match(re);
      // A fixture can legitimately contain these words - a stack trace says "undefined
      // method", a test asserts NaN. Only a line the renderer built counts, so the line
      // has to be absent from the log itself.
      if (hit && !fx(name).includes(hit[0])) leaks.push(`${name} (${r.tool}): ${why} - ${JSON.stringify(hit[0])}`);
    }
  }
  assert.deepEqual(leaks, [], "the rendered output carried an unformatted value");
  console.log("  ok   every fixture renders without leaking a raw value");
  pass++;
} catch (e) {
  console.log(`  FAIL every fixture renders without leaking a raw value\n       ${e.message}`);
  fail++;
}

// The problem matcher is how a `--quiet` CI job turns terminal output into annotations,
// and it is a regex living in a JSON file that nothing connected to the renderer. It
// needs something after the location to use as the message, so a failure with no name
// rendered as a bare "broken.go:4" and CI silently annotated nothing for go, go vet and
// a cargo manifest. Neither side knew.
try {
  const { render, setColor } = await import("../src/render.js");
  setColor(false);
  const matcher = JSON.parse(readFileSync(join(here, "..", ".github", "whyitbroke.problem-matcher.json"), "utf8"));
  const re = new RegExp(matcher.problemMatcher[0].pattern[0].regexp);
  // what the renderer emits for a located failure: two spaces, "file:line[:col]", a name
  const LOCATION_LINE = /^  (\S.*?):(\d+)(?::(\d+))?(?:  (.*))?$/;
  const unreadable = [];
  let seen = 0;
  for (const name of readdirSync(join(here, "fixtures"))) {
    let r;
    try { r = analyse(fx(name)); } catch { continue; }
    if (!r?.failures.length) continue;
    for (const line of render(r, { source: false }).split("\n")) {
      if (!LOCATION_LINE.test(line)) continue;
      seen++;
      if (!re.test(line)) unreadable.push(`${name} (${r.tool}): ${JSON.stringify(line)}`);
    }
  }
  assert.ok(seen > 80, `only ${seen} location lines exercised`);
  assert.deepEqual(unreadable, [], "CI would annotate nothing for these");
  console.log(`  ok   the problem matcher reads all ${seen} rendered location lines`);
  pass++;
} catch (e) { console.log(`  FAIL problem matcher coverage\n       ${e.message}`); fail++; }

// crafted output must not be able to make us read files outside the working dir
try {
  const { render, setColor } = await import("../src/render.js");
  const { resetSnippetCache } = await import("../src/snippet.js");
  const { writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  setColor(false);
  const outside = join(tmpdir(), "whyitbroke-must-not-read.txt");
  writeFileSync(outside, "TOP SECRET CONTENTS\n");
  resetSnippetCache();
  const out = render({ tool: "tsc", failures: [{ file: outside, line: 1, title: "TS1", message: "x" }] }, {});
  assert.ok(!/TOP SECRET/.test(out), "read a file outside the working directory");
  console.log("  ok   refuses to read source outside the working directory");
  pass++;
} catch (e) { console.log(`  FAIL path confinement\n       ${e.message}`); fail++; }

// context width adapts to how much the message explains, and never crosses a blank line
try {
  const { render, setColor } = await import("../src/render.js");
  const { resetSnippetCache } = await import("../src/snippet.js");
  const { writeFileSync, mkdtempSync, rmSync } = await import("node:fs");
  setColor(false);
  const dir = mkdtempSync(join(process.cwd(), ".tmp-ctx-"));
  const file = join(dir, "t.py");
  writeFileSync(file,
    "def setup():\n    a = 1\n    b = 2\n    return a\n\n\ndef other():\n    pass\n");

  resetSnippetCache();
  const bare = render({ tool: "t", failures: [
    { file, line: 4, title: "x", message: "KeyError: 'exp'" }] }, {});
  assert.match(bare, /def setup/, "a bare message should reach back for context");
  assert.ok(!/def other/.test(bare), "context must not spill into the next block");

  resetSnippetCache();
  const wordy = render({ tool: "t", failures: [
    { file, line: 4, title: "x",
      message: "Argument 1 to \"total\" has incompatible type \"str\"; expected \"list[int]\"" }] }, {});
  const count = (t) => (t.match(/^\s+\d+ \u2502/gm) || []).length;   // numbered source lines
  assert.ok(count(wordy) < count(bare),
    `a self-explanatory message should show less code (${count(wordy)} vs ${count(bare)})`);

  rmSync(dir, { recursive: true, force: true });
  console.log("  ok   context width adapts and stops at block boundaries");
  pass++;
} catch (e) { console.log(`  FAIL adaptive context\n       ${e.message}`); fail++; }

// two failures a line apart, both carrying the source line they are about
try {
  const { render, setColor } = await import("../src/render.js");
  const { resetSnippetCache } = await import("../src/snippet.js");
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  setColor(false);
  // inside the working directory: snippet() refuses to read source outside it
  const dir = mkdtempSync(join(process.cwd(), ".tmp-near-"));
  const file = join(dir, "near.swift");
  writeFileSync(file, ['let a = 1', 'let x: Int = "hello"', 'print(a, y)', ''].join("\n"));
  resetSnippetCache();

  const out = render({ tool: "swift", failures: [
    { file, line: 2, col: 14, title: "compile error", message: "cannot convert value", stmt: 'let x: Int = "hello"' },
    { file, line: 3, col: 10, title: "compile error", message: "cannot find 'y' in scope", stmt: "print(a, y)" },
  ] }, {});

  rmSync(dir, { recursive: true, force: true });

  // The second failure sits inside the region the first one's snippet already covered,
  // so the renderer shows just its line with a caret. `stmt` is the stand-in for source
  // that could NOT be shown - printing it as well said the line a third time, unnumbered.
  // swiftc was the first parser to set a location and a stmt together.
  const unnumbered = out.split("\n")
    .filter((l) => /^\s+\u2502 /.test(l))        // a pipe with no line number in front
    .filter((l) => !/^\s+\u2502 *\^\s*$/.test(l));  // the caret line is one of those, and is fine
  assert.deepEqual(unnumbered, [], `the statement was printed again with no line number:\n${out}`);
  console.log("  ok   a failure beside the last one does not print its line twice");
  pass++;
} catch (e) { console.log(`  FAIL near-failure duplicate line\n       ${e.message}`); fail++; }

// a caret under a line indented with a tab
try {
  const { render, setColor } = await import("../src/render.js");
  const { resetSnippetCache } = await import("../src/snippet.js");
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  setColor(false);
  const dir = mkdtempSync(join(process.cwd(), ".tmp-tab-"));
  const file = join(dir, "main.go");
  writeFileSync(file, "package main\n\nfunc main() {\n\tfmt.Println(x)\n}\n");
  resetSnippetCache();
  // go counts the tab as one column: `./main.go:4:14: undefined: x`
  const out = render({ tool: "go", failures: [
    { file, line: 4, col: 14, title: "compile error", code: "UndeclaredName", message: "undefined: x" },
  ] }, {});
  rmSync(dir, { recursive: true, force: true });
  const lines = out.split("\n");
  const source = lines.findIndex((l) => /^\s+4 \u2502 \tfmt/.test(l));
  assert.ok(source >= 0, `no source line in:\n${out}`);
  // A terminal draws a tab out to the next tab stop. A tab under it is drawn the same
  // width, which one blank per character is not: the caret sat under the tab.
  assert.equal(lines[source + 1], "        \u2502 \t            ^");
  assert.equal(lines[source + 1].indexOf("^"), lines[source].indexOf("x"));
  console.log("  ok   a caret under a line indented with a tab lands under its character");
  pass++;
} catch (e) { console.log(`  FAIL caret under a tab\n       ${e.message}`); fail++; }

// a caret under characters the terminal draws wider, or narrower, than one column
try {
  const { render, setColor } = await import("../src/render.js");
  const { resetSnippetCache } = await import("../src/snippet.js");
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  setColor(false);
  const dir = mkdtempSync(join(process.cwd(), ".tmp-wide-"));
  let n = 0;
  // Every case is the same line with a different run inside the string, and the caret
  // always belongs under the final `g`. Its column in UTF-16 units - which is what a tool
  // reports and what the caret is counted from - is 33 plus the length of that run.
  const caretFor = (filler) => {
    const file = join(dir, `w${n++}.ts`);
    writeFileSync(file, `const g = "${filler}"; const n: number = g;\n`);
    resetSnippetCache();
    const out = render({ tool: "tsc", failures: [{ file, line: 1, col: filler.length + 33,
      title: "TS2322", message: "no" }] }, {});
    const lines = out.split("\n");
    const source = lines.findIndex((l) => /^\s+1 \u2502 const g/.test(l));
    assert.ok(source >= 0, `no source line in:\n${out}`);
    assert.equal(lines[source].at(-2), "g", "the column under test is the final g");
    return lines[source + 1];
  };

  // The test does not carry its own width table - that would pass whenever both copies
  // were wrong together. Instead each run is paired with ASCII that the terminal draws
  // exactly as wide, and the two must put the caret in the same column. Everything that
  // differs between the pair is how many UTF-16 units the caret is counted from, which
  // is precisely what conflating units with columns got wrong.
  for (const [what, filler, sameWidthInAscii] of [
    ["japanese", "こんにちは", "AAAAAAAAAA"],
    ["hangul", "안녕하세요", "AAAAAAAAAA"],
    ["fullwidth latin", "ＡＢＣ", "AAAAAA"],
    ["cjk with a narrow neighbour", "日本語です。x", "AAAAAAAAAAAAx"],
    // Already correct, and easy to break while fixing the rest: an emoji is two UTF-16
    // units and is drawn two columns wide, so counting either way lands in the sameplace.
    ["emoji", "🎉🎉", "AAAA"],
    // The other direction. A combining acute is a unit of its own and is drawn over the
    // letter before it, taking no column at all, so counting units moved the caret right.
    ["combining marks", "cafe\u0301 e\u0301te\u0301", "cafe ete"],
  ]) {
    assert.equal(caretFor(filler), caretFor(sameWidthInAscii),
      `${what}: the caret is not where the same width in ASCII puts it`);
  }
  rmSync(dir, { recursive: true, force: true });
  console.log("  ok   a caret under wide and zero-width characters lands under its character");
  pass++;
} catch (e) { console.log(`  FAIL caret under wide characters\n       ${e.message}`); fail++; }

// a headline that is the whole diagnosis
try {
  const { render, setColor } = await import("../src/render.js");
  setColor(false);

  // yarn and kubectl have nothing but the sentence: no file to open, no code, no unwind.
  // The block underneath added a bare "error" label and said the sentence again.
  for (const name of ["yarn_fail.txt", "kubectl_noserver_fail.txt"]) {
    const out = render(analyse(fx(name)), { source: false });
    const body = out.split("\n").filter((l) => l.trim());
    assert.equal(body.length, 1, `${name} says it more than once:\n${out}`);
    assert.match(body[0], /^  \u2717 /, `${name}: the headline should be what survives`);
    assert.doesNotMatch(out, /^ +error$/m, `${name}: a bare severity label is not a diagnosis`);
  }

  // pnpm carries a real code, so the block stays - only the echoed sentence goes.
  const pnpm = render(analyse(fx("pnpm_script_fail.txt")), { source: false });
  assert.match(pnpm, /ERR_PNPM_NO_SCRIPT/, "the code is why the block is worth keeping");
  const echoes = pnpm.split("\n").filter((l) => l.includes("Missing script: nonexistent-script"));
  assert.equal(echoes.length, 1, `the message appears ${echoes.length} times:\n${pnpm}`);

  // and a headline that merely counts must never swallow the failures under it
  const counted = render(analyse(fx("eslint_fail.txt")), { source: false });
  assert.ok(counted.split("\n").filter((l) => l.trim()).length > 2,
    "a counting headline is not the whole diagnosis");
  console.log("  ok   a headline that is the whole diagnosis is not said twice");
  pass++;
} catch (e) { console.log(`  FAIL headline said twice\n       ${e.message}`); fail++; }

// a single absurdly long boilerplate line must not blow up the output
try {
  const { render, setColor } = await import("../src/render.js");
  setColor(false);
  const long = "available fixtures: " + Array.from({ length: 60 }, (_, i) => `fixture_${i}`).join(", ");
  const out = render({ tool: "pytest", failures: [
    { title: "t", message: "recursive dependency detected", stmt: long }] }, {});
  const longest = Math.max(...out.split("\n").map((l) => l.length));
  assert.ok(longest < 240, `a padding line was printed in full (${longest} chars)`);
  assert.match(out, /\u2026/, "truncation should be visible");
  assert.match(out, /available fixtures: fixture_0/, "the head of the line must survive");
  console.log("  ok   overlong boilerplate lines are clipped");
  pass++;
} catch (e) { console.log(`  FAIL long line clipping\n       ${e.message}`); fail++; }

// source that changed since the run must not be shown as if it were current
try {
  const { render, setColor } = await import("../src/render.js");
  const { resetSnippetCache } = await import("../src/snippet.js");
  const { writeFileSync, mkdtempSync, rmSync } = await import("node:fs");
  setColor(false);
  // must live under cwd: source reads outside it are refused by design
  const dir = mkdtempSync(join(process.cwd(), ".tmp-test-"));
  const file = join(dir, "a.rs");

  writeFileSync(file, "let s: String = 42;\n");
  const result = { tool: "cargo", failures: [{ file, line: 1, title: "E0308",
    message: "mismatched types", stmt: "let s: String = 42;" }] };
  const fresh = render(result, {});
  assert.match(fresh, /1 . let s: String = 42;/, "matching file should show the snippet");
  assert.ok(!/has changed/.test(fresh), "matching file must not warn");

  writeFileSync(file, "something else entirely\n");
  resetSnippetCache();
  const drifted = render(result, {});
  assert.match(drifted, /has changed since this ran/, "changed file must warn");
  assert.ok(!/something else entirely/.test(drifted), "must not print the new file's contents");
  assert.equal((drifted.match(/let s: String = 42;/g) || []).length, 1, "line printed exactly once");
  rmSync(dir, { recursive: true, force: true });
  console.log("  ok   stale source is detected, not shown");
  pass++;
} catch (e) { console.log(`  FAIL stale source\n       ${e.message}`); fail++; }

// a file too short to hold the line is proof on its own that it changed
try {
  const { render, setColor } = await import("../src/render.js");
  const { resetSnippetCache } = await import("../src/snippet.js");
  const { writeFileSync, mkdtempSync, rmSync } = await import("node:fs");
  setColor(false);
  const dir = mkdtempSync(join(process.cwd(), ".tmp-test-"));
  const file = join(dir, "a.py");

  // The check above needs the tool to have quoted the line it saw. mypy, and plenty of
  // others, print only a location - and a log read after the fact (`whyitbroke < build.log`,
  // or a suite still running while the file is edited) can name a line the file no longer
  // reaches. The window clamped to the end of the file and printed whatever was there
  // under the heading of the line that failed, containing no hit line at all.
  writeFileSync(file, "aa\nbb\ncc\ndd\nee EXPLODES\n");
  const result = { tool: "mypy", failures: [{ file, line: 5, message: "division is unsupported" }] };
  assert.match(render(result, {}), /5 . ee EXPLODES/, "a line the file does have is shown");

  writeFileSync(file, "SHOULD NOT APPEAR\n");
  resetSnippetCache();
  const gone = render(result, {});
  assert.match(gone, /has changed since this ran — it has no line 5/, "a short file must say so");
  assert.ok(!/SHOULD NOT APPEAR/.test(gone), "must not print the new file's contents");

  // When the tool did quote the line, that quote is still worth showing - exactly once.
  const quoted = render({ tool: "pytest", failures: [{ file, line: 5,
    message: "AssertionError: assert 2 == 3", stmt: "assert compute() == 3" }] }, {});
  assert.match(quoted, /has changed since this ran — it has no line 5/);
  assert.equal((quoted.match(/assert compute\(\) == 3/g) || []).length, 1,
    "the quoted line is printed exactly once");

  // A file that cannot be read at all is not evidence of anything. Unreadable and
  // too-short are different answers and only one of them is a claim about the file.
  rmSync(file);
  resetSnippetCache();
  assert.ok(!/has changed/.test(render(result, {})), "an unreadable file is not called changed");

  // The same fact at the level below: snippet() promises a window *around* the line that
  // failed. Out of range it clamped to the end of the file and returned one with no hit
  // in it, and the block trimming then worked from a `hit` index of -1. Render no longer
  // asks in that case, so only an assertion here holds the function to its own contract.
  const { snippet } = await import("../src/snippet.js");
  writeFileSync(file, "aa\nbb\ncc\ndd\nee\n");
  resetSnippetCache();
  for (const ctx of [0, 1, 2, 3, 4, 8]) {
    assert.equal(snippet(file, 9, ctx), null, `ctx ${ctx}: a line the file lacks has no window`);
    const window = snippet(file, 3, ctx);
    assert.ok(window?.some((l) => l.hit), `ctx ${ctx}: a window must contain the line it is for`);
  }

  rmSync(dir, { recursive: true, force: true });
  console.log("  ok   a line the file no longer has is reported, not filled in");
  pass++;
} catch (e) { console.log(`  FAIL vanished source line\n       ${e.message}`); fail++; }

try {
  const { render } = await import("../src/render.js");
  const fs = (await import("node:fs")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  // snippet.js opens descriptors - openSync, not readFileSync - so counting
  // readFileSync alone counted a call that is never made, and the assertion below held
  // however many files were read. Both are hooked now.
  const originalRead = fs.readFileSync;
  const originalOpen = fs.openSync;
  let reads = 0, out;
  try {
    fs.readFileSync = (...args) => { reads++; return originalRead(...args); };
    fs.openSync = (...args) => { reads++; return originalOpen(...args); };
    syncBuiltinESMExports();
    out = render({ failures: [{ file: cli, line: 1, message: "bad", stmt: "total = value" }] }, { source: false });
  } finally {
    fs.readFileSync = originalRead;
    fs.openSync = originalOpen;
    syncBuiltinESMExports();
  }
  assert.equal(reads, 0, "--no-source must not read files for snippets or stale-source checks");
  assert.match(out, /total = value/);
  console.log("  ok   no-source renders captured statements without any source reads");
  pass++;
} catch (e) { console.log(`  FAIL no-source read isolation\n       ${e.message}`); fail++; }

// A path is shortened by taking the working directory off the front of it. The test for
// that was cwd + "/", and on Windows the separator is "\\" - so nothing was ever shortened
// there and every diagnostic showed its full absolute path. A log can also be written on
// one platform and read on another, so both separators count wherever this runs.
try {
  const { relPath } = await import("../src/util.js");
  const cwd = process.cwd, platform = Object.getOwnPropertyDescriptor(process, "platform");
  const as = (plat, dir, fn) => {
    Object.defineProperty(process, "platform", { value: plat, configurable: true });
    process.cwd = () => dir;
    try { fn(); } finally {
      Object.defineProperty(process, "platform", platform);
      process.cwd = cwd;
    }
  };
  as("win32", "C:\\Users\\dev\\app", () => {
    assert.equal(relPath("C:\\Users\\dev\\app\\src\\index.ts"), "src\\index.ts");
    // Windows matches paths without regard to case; nothing else does.
    assert.equal(relPath("c:\\users\\dev\\app\\src\\index.ts"), "src\\index.ts");
    // A sibling directory that merely starts with the same letters is not inside it.
    assert.equal(relPath("C:\\Users\\dev\\appendix\\x.ts"), "C:\\Users\\dev\\appendix\\x.ts");
    assert.equal(relPath("D:\\other\\x.ts"), "D:\\other\\x.ts");
  });
  as("linux", "/home/dev/app", () => {
    assert.equal(relPath("/home/dev/app/src/index.ts"), "src/index.ts");
    assert.equal(relPath("/home/dev/appendix/x.ts"), "/home/dev/appendix/x.ts");
    // Outside the directory it stays absolute: "../../other/x.ts" would be worse to read.
    assert.equal(relPath("/other/x.ts"), "/other/x.ts");
    assert.equal(relPath(undefined), undefined);
  });
  console.log("  ok   a path under the working directory is shortened on either platform");
  pass++;
} catch (e) { console.log(`  FAIL relative paths across platforms\n       ${e.message}`); fail++; }

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
