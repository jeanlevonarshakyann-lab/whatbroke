// What share of real failing commands whatbroke reads: `npm run coverage`.
//
// Every other measurement in this repo runs against the corpus, which is captures taken
// once and committed. This one runs the tools. It writes a small broken project for each
// one, runs the command that fails on it, and reports what came back - so a claim about
// coverage can be re-made on another machine instead of quoted from whenever it was last
// measured.
//
// Nothing here is a test. It needs the tools installed, it reaches the network for the
// package managers, and what a tool prints changes between versions - all three of which
// are why the corpus exists. A tool that is not installed is skipped and said so; the
// share is of what actually ran.
//
// A run counts as READ only when a real parser owns the log and reports a failure. The
// fallback getting the right line still counts as a guess, because the point of the
// number is how much is read by something that knows the tool.
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "whatbroke.js");

/** [group, tool, files to write, argv that fails on them] */
const CASES = [
  ["lint", "ruff", { "shop.py": "import os\nimport sys\n\n\ndef total(items):\n    x = 1\n    return sum(items)\n" }, ["ruff", "check", "."]],
  ["lint", "shellcheck", { "s.sh": "#!/bin/bash\nif [ $1 == \"x\" ]; then\n  echo $undefined\nfi\n" }, ["shellcheck", "s.sh"]],
  ["lint", "yamllint", { "y.yaml": "key: value\n  bad: indent\n" }, ["yamllint", "y.yaml"]],
  ["lint", "markdownlint", { "m.md": "#Heading no space\nSome text\n" }, ["markdownlint", "m.md"]],
  ["lint", "pylint", { "m.py": "def add(a, b):\n    return a + b\n" }, ["pylint", "m.py"]],
  ["lint", "flake8", { "f.py": "import os\nx=1\n" }, ["flake8", "f.py"]],
  ["type", "mypy", { "m.py": "def add(a: int, b: int) -> int:\n    return a + b\n\nadd(\"x\", 1)\n" }, ["mypy", "m.py"]],
  ["type", "pyright", { "m.py": "def add(a: int, b: int) -> int:\n    return a + b\n\nadd(\"x\", 1)\n" }, ["pyright", "m.py"]],
  ["type", "tsc", { "bad.ts": "const n: number = \"hello\";\n" }, ["tsc", "--noEmit", "bad.ts"]],
  ["compile", "clang", { "bad.c": "int main(void) { return undefined_symbol; }\n" }, ["clang", "-c", "bad.c", "-o", "/dev/null"]],
  ["compile", "swiftc", { "bad.swift": "let x: Int = \"hello\"\n" }, ["swiftc", "bad.swift", "-o", "/dev/null"]],
  ["compile", "javac", { "Bad.java": "public class Bad { public static void main(String[] a) { int x = \"s\"; } }\n" }, ["javac", "Bad.java"]],
  ["compile", "cargo", { "Cargo.toml": "[package]\nname = \"c\"\nversion = \"0.1.0\"\nedition = \"2021\"\n", "src/main.rs": "fn main() { let x: i32 = \"hello\"; }\n" }, ["cargo", "build"]],
  ["test", "go test", { "go.mod": "module g\n\ngo 1.21\n", "s_test.go": "package g\n\nimport \"testing\"\n\nfunc TestA(t *testing.T) { t.Errorf(\"got %d, want 3\", 2) }\n" }, ["go", "test", "./..."]],
  ["test", "node --test", { "t.test.js": "const { test } = require(\"node:test\");\nconst a = require(\"node:assert\");\ntest(\"adds\", () => { a.strictEqual(1 + 1, 3); });\n" }, ["node", "--test"]],
  ["test", "pytest", { "test_shop.py": "def test_one():\n    assert 1 == 2\n" }, ["python3", "-m", "pytest", "-q"]],
  ["test", "unittest", { "test_u.py": "import unittest\n\nclass T(unittest.TestCase):\n    def test_a(self):\n        self.assertEqual(1, 2)\n" }, ["python3", "-m", "unittest"]],
  ["runtime", "python", { "boom.py": "raise KeyError(\"missing config key\")\n" }, ["python3", "boom.py"]],
  ["runtime", "ruby", { "r.rb": "def f\n  x = \nend\n" }, ["ruby", "r.rb"]],
  ["runtime", "perl", { "p.pl": "use strict;\nmy $x = ;\n" }, ["perl", "p.pl"]],
  ["runtime", "php", { "p.php": "<?php\nfunction f( {\n" }, ["php", "-l", "p.php"]],
  ["runtime", "deno", { "d.ts": "throw new RangeError(\"out of stock\");\n" }, ["deno", "run", "d.ts"]],
  ["runtime", "bun", { "b.ts": "throw new RangeError(\"out of stock\");\n" }, ["bun", "b.ts"]],
  ["build", "cmake", { "CMakeLists.txt": "cmake_minimum_required(VERSION 3.10)\nundefined_command(foo)\n" }, ["cmake", "."]],
  ["build", "esbuild", { "e.js": "const x = {a:1,\n" }, ["esbuild", "e.js"]],
  ["package", "npm", { "package.json": "{\"name\":\"x\",\"private\":true,\"scripts\":{\"build\":\"true\"}}\n" }, ["npm", "run", "nosuchscript"]],
  ["package", "pip", {}, ["pip", "install", "nonexistent-package-xyzzy-12345==9.9.9"]],
  ["vcs", "git", {}, ["git", "pull"]],

  // Tools that read a project rather than a single file. Each still writes only what it
  // needs; anything wanting an install step is left out, because a measurement that has
  // to fetch a dependency tree first is measuring the network.
  ["lint", "eslint", { "eslint.config.js": "export default [{ rules: { eqeqeq: \"error\" } }];\n", "package.json": "{\"name\":\"c\",\"type\":\"module\",\"private\":true}\n", "shop.js": "if (1 == 2) {}\n" }, ["eslint", "shop.js"]],
  ["lint", "oxlint", { "shop.js": "const unused = 1;\nif (unused == null) { debugger; }\n" }, ["oxlint", "-D", "correctness", "-D", "suspicious", "shop.js"]],
  ["lint", "stylelint", { ".stylelintrc.json": "{ \"rules\": { \"length-zero-no-unit\": true } }\n", "shop.css": ".c { margin: 0px; }\n" }, ["stylelint", "shop.css"]],
  ["lint", "rubocop", { ".rubocop.yml": "AllCops:\n  NewCops: disable\n", "shop.rb": "class shop\nend\n" }, ["rubocop", "shop.rb"]],
  ["lint", "golangci-lint", { "go.mod": "module g\n\ngo 1.21\n", "shop.go": "package g\n\nfunc T() int {\n\tunused := 1\n\treturn 0\n}\n" }, ["golangci-lint", "run", "./..."]],
  ["lint", "biome", { "b.js": "const unused = 1;\nif (unused == null) { debugger; }\n" }, ["biome", "check", "b.js"]],
  ["format", "prettier", { "p.js": "const x = {a:1,\n" }, ["prettier", "--check", "p.js"]],
  ["format", "black", { "f.py": "def  bad( ):\n    return  1\n" }, ["black", "--check", "f.py"]],
  ["format", "sass", { "shop.scss": ".a {\n  color: $missing-var;\n}\n" }, ["sass", "shop.scss"]],
  ["compile", "dotnet", { "Shop.csproj": "<Project Sdk=\"Microsoft.NET.Sdk\">\n  <PropertyGroup>\n    <OutputType>Exe</OutputType>\n    <TargetFramework>net9.0</TargetFramework>\n  </PropertyGroup>\n</Project>\n", "Program.cs": "class Shop { static void Main() { int x = \"hello\"; } }\n" }, ["dotnet", "build"]],
  ["build", "swc", { "e.js": "const x = {a:1,\n" }, ["swc", "e.js"]],
  ["build", "webpack", { "e.js": "const x = {a:1,\n" }, ["webpack", "--entry", "./e.js", "--mode", "production"]],
  ["build", "make", { "Makefile": "all: bad.o\n\nbad.o: bad.c\n\tclang -c bad.c -o bad.o\n", "bad.c": "int main(void) { return undefined_symbol; }\n" }, ["make"]],
  ["package", "bundle", { "Gemfile": "source \"https://rubygems.org\"\n\ngem \"invoice-formatter-xyzzy\"\n" }, ["bundle", "install"]],
  ["package", "composer", { "composer.json": "{\n  \"name\": \"shop/api\",\n  \"require\": { \"vendor/definitely-not-real-xyzzy\": \"^1.0\" }\n}\n" }, ["composer", "install", "--no-interaction"]],
  ["package", "uv", { "pyproject.toml": "[project]\nname = \"shop\"\nversion = \"0.1.0\"\ndependencies = [\"definitely-not-real-xyzzy>=1.0\"]\n" }, ["uv", "lock"]],
  ["package", "poetry", { "pyproject.toml": "[project]\nname = \"shop\"\nversion = \"0.1.0\"\ndependencies = [\"definitely-not-real-xyzzy>=1.0\"]\n" }, ["poetry", "lock"]],
  ["infra", "terraform", { "main.tf": "output \"o\" {\n  value = var.undefined_one\n}\n" }, ["terraform", "validate"]],
  ["infra", "kubectl", { "bad.yaml": "apiVersion: v1\nkind: Pod\nmetadata:\n  name: shop\nspec:\n  containers:\n  - name: api\n    image: nginx\n    ports:\n    - containerPort: \"80\"\n" }, ["kubectl", "apply", "--dry-run=client", "-f", "bad.yaml"]],
  ["infra", "docker", { "Dockerfile": "FROM alpine:3.19\nRUN nosuchcommand --help\n" }, ["docker", "build", "."]],
];

const have = (argv) => spawnSync(process.platform === "win32" ? "where" : "which", [argv[0]], { encoding: "utf8" }).status === 0;

function read(dir, argv) {
  const r = spawnSync(process.execPath, [cli, "--json", "--", ...argv],
    { cwd: dir, encoding: "utf8", timeout: 300000, maxBuffer: 64 * 1024 * 1024 });
  try {
    const j = JSON.parse(r.stdout);
    const n = j.failures?.length ?? 0;
    if (!j.tool || n === 0) return { state: "none" };
    return { state: j.guessed ? "guess" : "read", tool: j.tool, n };
  } catch { return { state: "none" }; }
}

const tally = { read: 0, guess: 0, none: 0, skip: 0 };
// Cases are written where they were found rather than sorted, so gather them by group
// before printing: a heading that appears twice reads as two different things.
const order = [...new Set(CASES.map(([g]) => g))];
const grouped = order.flatMap((g) => CASES.filter(([c]) => c === g));
let group = "";
for (const [g, name, files, argv] of grouped) {
  if (g !== group) { group = g; console.log(`\n  ${group}`); }
  if (!have(argv)) { console.log(`    skip  ${name.padEnd(15)} not installed`); tally.skip++; continue; }
  const dir = mkdtempSync(join(tmpdir(), "whatbroke-coverage-"));
  try {
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(join(dir, dirname(path)), { recursive: true });
      writeFileSync(join(dir, path), body);
    }
    if (name === "git") spawnSync("git", ["init", "-q", "."], { cwd: dir });
    const got = read(dir, argv);
    const mark = got.state === "read" ? "ok  " : got.state === "guess" ? "GUESS" : "NONE";
    console.log(`    ${mark.padEnd(6)}${name.padEnd(15)}${got.tool ? `${got.tool}, ${got.n} failure(s)` : "nothing read"}`);
    tally[got.state]++;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const ran = tally.read + tally.guess + tally.none;
console.log(`\n  ${tally.read} of ${ran} read by a real parser` +
  `${tally.guess ? `, ${tally.guess} by the fallback` : ""}` +
  `${tally.none ? `, ${tally.none} not read` : ""}` +
  `${tally.skip ? ` (${tally.skip} tools not installed)` : ""}\n`);
process.exitCode = 0;
