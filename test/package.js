import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const temp = mkdtempSync(join(tmpdir(), "whatbroke-package-"));
const packDir = join(temp, "pack");
const installDir = join(temp, "install");
const cacheDir = join(temp, "npm-cache");
const env = { ...process.env, npm_config_cache: cacheDir };

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env,
    maxBuffer: 10 * 1024 * 1024,
    timeout: 120_000,
    ...options,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")} exited ${result.status}\n${result.stderr || result.stdout}`,
  );
  return result;
}

function runShim(name, args, options = {}) {
  const suffix = process.platform === "win32" ? ".cmd" : "";
  const shim = join(installDir, "node_modules", ".bin", name + suffix);
  assert.equal(existsSync(shim), true, `missing installed ${name} command shim`);
  return run(shim, args, {
    shell: process.platform === "win32",
    ...options,
  });
}

console.log("\npackage boundary");

try {
  mkdirSync(packDir);
  mkdirSync(installDir);
  writeFileSync(
    join(installDir, "package.json"),
    JSON.stringify({ name: "whatbroke-package-smoke", private: true }),
  );

  const packed = run(npm, [
    "pack",
    "--ignore-scripts",
    "--json",
    "--pack-destination",
    packDir,
  ], { cwd: root });
  const packJson = JSON.parse(packed.stdout);
  // npm 7-10 return an array; npm 11 keys the result by package name.
  const entries = Array.isArray(packJson) ? packJson : Object.values(packJson);
  assert.equal(entries.length, 1);
  const metadata = entries[0];
  assert.equal(metadata.name, manifest.name);
  assert.equal(metadata.version, manifest.version);
  const files = new Set(metadata.files.map(({ path }) => path));
  for (const required of ["package.json", "bin/whatbroke.js", "src/index.js"]) {
    assert.equal(files.has(required), true, `${required} is missing from the npm package`);
  }

  const tarball = join(packDir, metadata.filename);
  assert.equal(existsSync(tarball), true, "npm did not create the package tarball");
  run(npm, [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--package-lock=false",
    "--offline",
    tarball,
  ], { cwd: installDir });

  for (const command of ["whatbroke", "wb"]) {
    const version = runShim(command, ["--version"]);
    assert.equal(version.stdout.trim(), metadata.version);
  }

  const fixture = readFileSync(join(here, "fixtures", "pytest_fail.txt"), "utf8");
  const analysed = runShim("whatbroke", ["--json"], { input: fixture });
  const result = JSON.parse(analysed.stdout);
  assert.equal(result.tool, "pytest");
  assert.equal(result.failures.length, 3);
  assert.equal(result.summary, "3 failed, 2 passed in 0.01s");

  console.log("  ok   packed tarball installs offline and both command shims parse a real fixture");
  console.log("\n  1 passed, 0 failed");
} catch (error) {
  console.log(`  FAIL packed package smoke test\n       ${error.stack || error.message}`);
  console.log("\n  0 passed, 1 failed");
  process.exitCode = 1;
} finally {
  rmSync(temp, { recursive: true, force: true });
}
