import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyse } from "../src/index.js";
import { createCapture } from "../src/capture.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fx = (name) => readFileSync(join(fixtures, name), "utf8");
let passed = 0;

function test(name, run) {
  try {
    run();
    passed++;
    console.log("  ok   " + name);
  } catch (error) {
    console.error("  FAIL " + name + "\n       " + (error.stack ?? error));
    process.exitCode = 1;
  }
}

test("--max-bytes includes generated elision markers", () => {
  const limit = 1024;
  const capture = createCapture(limit);
  capture.push(Buffer.from("ordinary output\n".repeat(10_000)));
  const result = capture.finish();
  assert.equal(result.truncated, true);
  assert.match(result.text, /bytes of output elided here/);
  assert.ok(Buffer.byteLength(result.text) <= limit,
    "returned " + Buffer.byteLength(result.text) + " bytes for a " + limit + "-byte cap");
});

test("pytest keeps spaces in parameter ids and history identity", () => {
  const text = fx("pytest_fail.txt").replaceAll("test_param[2]", "test_param[case with space]");
  const result = analyse(text, { cluster: false });
  const failure = result.failures.find((item) => item.title === "test_param[case with space]");
  assert.equal(result.tool, "pytest");
  assert.equal(failure?.subject, "test_shop.py::test_param[case with space]");
  assert.equal(failure?.file, "test_shop.py");
  assert.equal(failure?.line, 12);
});

test("Python keeps a bare custom exception type", () => {
  const text = [
    "Traceback (most recent call last):",
    '  File "/tmp/project/main.py", line 7, in <module>',
    "    raise BuildStopped",
    "BuildStopped",
    "",
  ].join("\n");
  const result = analyse(text, { cluster: false });
  assert.equal(result.tool, "python");
  assert.equal(result.failures[0].message, "BuildStopped");
});

test("Deno test accepts paths containing spaces", () => {
  const text = fx("deno_fail.txt")
    .replaceAll("./math_test.ts", "./my project/math_test.ts")
    .replaceAll("file:///home/dev/denoproj/", "file:///home/dev/my project/denoproj/");
  const result = analyse(text, { cluster: false });
  assert.equal(result.tool, "deno test");
  assert.equal(result.failures.length, 2);
  assert.ok(result.failures.every((failure) => failure.file === "./my project/math_test.ts"));
});

test("Jest stack locations accept paths containing spaces", () => {
  const text = fx("jest_fail.txt")
    .replaceAll("./sum.test.js", "./my project/sum.test.js")
    .replaceAll("sum.test.js:", "my project/sum.test.js:")
    .replaceAll("matching sum.test.js", "matching my project/sum.test.js");
  const result = analyse(text, { cluster: false });
  assert.equal(result.tool, "jest");
  assert.ok(result.failures.every((failure) => failure.file === "my project/sum.test.js"));
});

test("Vitest distinguishes a root directory from a frame function", () => {
  const text = fx("vitest_fail.txt")
    .replaceAll("/home/dev/js", "/home/dev/my project/js")
    .replaceAll("shop.test.js", "my project/shop.test.js");
  const result = analyse(text, { cluster: false });
  assert.equal(result.tool, "vitest");
  assert.ok(result.failures.every((failure) => failure.file === "my project/shop.test.js"));
});

test("Flake8 paths containing spaces are not stripped as wrappers", () => {
  const text = fx("flake8_fail.txt").replaceAll("lint_me.py", "my project/lint_me.py");
  const result = analyse(text, { cluster: false });
  assert.equal(result.tool, "flake8");
  assert.equal(result.failures.length, 8);
  assert.ok(result.failures.every((failure) => failure.file === "my project/lint_me.py"));
  assert.equal(result.wrappers, undefined);
});

test("Oxlint agent and unix paths accept spaces", () => {
  for (const name of ["oxlint_agent_same_fail.txt", "oxlint_unix_fail.txt"]) {
    const text = fx(name).replaceAll("src/", "my project/src/");
    const result = analyse(text, { cluster: false });
    assert.equal(result.tool, "oxlint", name);
    assert.ok(result.failures.every((failure) => failure.file.startsWith("my project/src/")), name);
    assert.equal(result.wrappers, undefined, name);
  }
});

test("Webpack module paths accept spaces", () => {
  const text = fx("webpack_parse_fail.txt")
    .replaceAll("./wsrc/syn.js", "./my project/wsrc/syn.js");
  const result = analyse(text, { cluster: false });
  assert.equal(result.tool, "webpack");
  assert.equal(result.failures[0].file, "./my project/wsrc/syn.js");
  assert.equal(result.failures[0].line, 1);
  assert.equal(result.failures[0].col, 11);
});

test("Less paths accept spaces", () => {
  const text = fx("less_fail.txt")
    .replaceAll("/home/dev/app/bad.less", "/home/dev/my project/app/bad.less");
  const result = analyse(text, { cluster: false });
  assert.equal(result.tool, "less");
  assert.equal(result.failures[0].file, "/home/dev/my project/app/bad.less");
});

test("Jasmine normalises Windows file URLs independently of the host OS", () => {
  const text = fx("jasmine_fail.txt")
    .replaceAll("file:///home/dev/app/jas/", "file:///C:/Users/dev/my%20project/jas/");
  const result = analyse(text, { cluster: false });
  assert.equal(result.tool, "jasmine");
  assert.equal(result.failures[0].file, "C:/Users/dev/my project/jas/sum.spec.js");
});

test("AVA keeps locations whose paths contain spaces", () => {
  const text = fx("ava_fail.txt").replaceAll("av/sum.test.js", "my project/av/sum.test.js");
  const result = analyse(text, { cluster: false });
  assert.equal(result.tool, "ava");
  assert.ok(result.failures.every((failure) => failure.file === "my project/av/sum.test.js"));
  assert.deepEqual(result.failures.map((failure) => [failure.line, failure.col]), [[3, 38], [4, 69]]);
});

if (!process.exitCode) console.log("\n" + passed + " regression tests passed");
