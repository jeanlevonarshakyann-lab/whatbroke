// Regressions found by independent reliability audits at shared infrastructure edges.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { analyse } from "../src/index.js";
import { fileReference } from "../src/location.js";
import { render, setColor } from "../src/render.js";
import { resetSnippetCache } from "../src/snippet.js";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "bin", "whyitbroke.js");
const fx = (name) => readFileSync(join(here, "fixtures", name), "utf8");
let pass = 0, fail = 0;
const cleanups = [];
const test = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (error) { console.log(`  FAIL ${name}\n       ${error.message}`); fail++; }
};

test("stdout and stderr fragments cannot invent one diagnostic", () => {
  const script = `process.stdout.write("err"); setTimeout(() => {
    process.stderr.write("or: fake\\n"); setTimeout(() => process.exit(7), 20);
  }, 20);`;
  const r = spawnSync(process.execPath, [cli, "--json", process.execPath, "-e", script], {
    encoding: "utf8", timeout: 10000,
  });
  assert.equal(r.status, 7);
  const report = JSON.parse(r.stdout);
  assert.equal(report.failures.length, 0, "bytes from independent streams became `error: fake`");
  assert.match(report.fallback.rawOutput, /^err\nor: fake\n$/);
});

test("a non-pipe output failure survives a successful child exit", () => {
  const dir = mkdtempSync(join(tmpdir(), "wb-output-error-")); cleanups.push(dir);
  const hook = join(dir, "hook.mjs");
  writeFileSync(hook, `const write = process.stdout.write.bind(process.stdout);
let once = false;
process.stdout.write = function (...args) {
  if (!once) {
    once = true;
    setImmediate(() => process.stdout.emit("error", Object.assign(new Error("full"), { code: "ENOSPC" })));
    return false;
  }
  return write(...args);
};\n`);
  const child = `const b=Buffer.alloc(65536,97); let left=1024*1024;
function write(){ while(left>0){ left-=b.length; if(!process.stdout.write(b)) return process.stdout.once("drain",write); } }
write();`;
  const r = spawnSync(process.execPath, ["--import", hook, cli, process.execPath, "-e", child], {
    encoding: "utf8", timeout: 15000, maxBuffer: 2 * 1024 * 1024,
  });
  assert.equal(r.signal, null);
  assert.equal(r.status, 1, "the child success overwrote the output failure");
});

test("a nested task wrapper never becomes part of Cargo's file", () => {
  const raw = fx("cargo_short_fail.txt");
  const wrapped = raw.split("\n").map((line) => line.trim()
    ? `api:test: api:test: ${line}` : line).join("\n");
  const result = analyse(wrapped);
  assert.equal(result.tool, "cargo");
  assert.deepEqual(result.failures.map((f) => f.file), ["src/main.rs", "src/main.rs"]);
  assert.ok(result.wrappers?.length, "the removed wrapper was not reported");
});

test("file URLs remain portable paths and remote hosts remain absolute", () => {
  assert.equal(fileReference("file:///C:/Users/dev/my%20project/app.js"), "C:/Users/dev/my project/app.js");
  assert.equal(fileReference("file://localhost/app/a%20b.js"), "/app/a b.js");
  assert.equal(fileReference("file://synthetic-host/share/problem.js"), "//synthetic-host/share/problem.js");
  const bun = analyse(fx("bun_throw_fail.txt")
    .replaceAll("/home/dev/app/throw.test.ts", "file:///C:/Users/dev/my%20project/app.js"));
  assert.ok(bun.failures.every((f) => f.file === "C:/Users/dev/my project/app.js"));
  const node = analyse("TypeError: boom\n    at f (file://synthetic-host/share/problem.js:4:5)\n");
  assert.equal(node.failures[0].file, "//synthetic-host/share/problem.js");
});

test("Deno TAP keeps the assertion diff carried in its JSON diagnostic", () => {
  const result = analyse(fx("denotest_diff_tap_fail.txt"));
  assert.equal(result.tool, "deno test");
  assert.match(result.failures[0].message, /-\s+2/);
  assert.match(result.failures[0].message, /\+\s+3/);
});

test("a closing-tag spelling inside JUnit CDATA is literal text", () => {
  const result = analyse(fx("maven_cdata_close_fail.xml"));
  assert.equal(result.tool, "maven");
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].file, "C.java");
  assert.match(result.failures[0].message, /expected <\/failure> but got other/);
});

test("a captured source prefix is not accepted as the current whole line", () => {
  const dir = mkdtempSync(join(process.cwd(), ".tmp-stale-prefix-")); cleanups.push(dir);
  writeFileSync(join(dir, "secret.py"), 'password = "public"; api_key = "SYNTHETIC_CHANGED_VALUE"\n');
  const log = `=================================== FAILURES ===================================
_______________________________ test_secret ________________________________
>       password = "public"
E       AssertionError: mismatch

secret.py:1: AssertionError
=========================== short test summary info ============================
FAILED secret.py::test_secret - AssertionError: mismatch
1 failed in 0.01s
`;
  const r = spawnSync(process.execPath, [cli], {
    cwd: dir, input: log, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" },
  });
  assert.match(r.stdout, /has changed since this ran/);
  assert.doesNotMatch(r.stdout, /SYNTHETIC_CHANGED_VALUE/);
});

test("locations outside JavaScript's safe integer range are discarded", () => {
  const result = analyse("huge.js:9007199254740993:1: error: impossible coordinate\n");
  assert.ok(result?.failures.length);
  assert.equal(result.failures[0].line, undefined);
  assert.equal(result.failures[0].col, undefined);
});

test("a ZWJ emoji sequence occupies one glyph when the caret is placed", () => {
  const dir = mkdtempSync(join(process.cwd(), ".tmp-grapheme-")); cleanups.push(dir);
  const family = "👨‍👩‍👧‍👦";
  const source = `const x = "${family}" + badExpr();`;
  const file = join(dir, "emoji.js");
  writeFileSync(file, source + "\n");
  resetSnippetCache(); setColor(false);
  const col = source.indexOf("badExpr") + 1;
  const output = render({ tool: "test", failures: [
    { file, line: 1, col, title: "boom", message: "bad expression" },
  ] }, {});
  const caret = output.split("\n").find((line) => /│\s*\^/.test(line));
  const afterGutter = caret.slice(caret.indexOf("│") + 2);
  const spaces = afterGutter.indexOf("^");
  const asciiBefore = source.slice(0, source.indexOf(family)).length +
    source.slice(source.indexOf(family) + family.length, source.indexOf("badExpr")).length;
  assert.equal(spaces, asciiBefore + 2, `caret was ${spaces - (asciiBefore + 2)} cells off:\n${output}`);
});

for (const dir of cleanups) rmSync(dir, { recursive: true, force: true });
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
