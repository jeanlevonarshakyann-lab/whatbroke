// Source context is the only thing whatbroke reads from disk, and the log asking for
// it is untrusted by definition — a pasted paste, a CI artifact, someone else's
// machine. These cases pin the boundary: what may be opened, how much of it, and what
// happens to the diagnostic when the answer is "nothing".
//
// They are written on an eslint-shaped log on purpose. A pytest block quotes the
// source line it saw, so render's staleness check suppresses the snippet whenever the
// crafted log disagrees with the disk — which hides an unsafe READ behind a refusal to
// PRINT, and a containment test that cannot tell those apart proves nothing. eslint
// reports file:line with no echoed statement, so the snippet is read and printed
// unconditionally. That is also the stronger attack, and the one an attacker picks.
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "bin", "whatbroke.js");

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
};

// Symlinks need a privilege or developer mode on Windows, so those cases are skipped
// there rather than reported as failures of the code under test.
const canSymlink = (() => {
  if (platform() === "win32") return false;
  const d = mkdtempSync(join(tmpdir(), "wb-link-probe-"));
  try { symlinkSync(join(d, "nowhere"), join(d, "l")); return true; }
  catch { return false; }
  finally { rmSync(d, { recursive: true, force: true }); }
})();

const roots = [];
function project() {
  const dir = mkdtempSync(join(tmpdir(), "wb-src-"));
  roots.push(dir);
  return dir;
}

/** No captured statement, so nothing stands between the log and the file. */
const log = (file, line = 1, col = 7) =>
  `\n${file}\n  ${line}:${col}   error    Something is wrong  no-undef\n\n✖ 1 problem (1 error, 0 warnings)\n`;

/** A pytest block, which DOES quote the line the tool saw — for the stale cases. */
const pytestLog = (file, line, stmt) => `
=================================== FAILURES ===================================
_______________________________ test_something ________________________________

    def test_something():
>       ${stmt}
E       assert 1049 == 1050

${file}:${line}: AssertionError
=========================== short test summary info ============================
FAILED ${file}::test_something - assert 1049 == 1050
1 failed in 0.01s
`;

const run = (cwd, input, args = []) => spawnSync(process.execPath, [cli, ...args], {
  input, encoding: "utf8", cwd, env: { ...process.env, NO_COLOR: "1" }, timeout: 20000,
});

/** Every refusal must keep the diagnostic and drop only the snippet. */
function refuses(r, canary, where) {
  assert.notEqual(r.signal, "SIGTERM", "the process hung instead of refusing");
  assert.doesNotMatch(r.stdout, canary, "content outside the boundary reached stdout");
  assert.match(r.stdout, where, "the diagnostic itself must survive the refusal");
  assert.match(r.stdout, /Something is wrong/);
}

// ---------------------------------------------------------------- containment

test("a source file inside the working directory is still shown", () => {
  const dir = project();
  writeFileSync(join(dir, "app.js"), "const ok = INSIDE_OK;\n");
  const r = run(dir, log("app.js"));
  assert.match(r.stdout, /INSIDE_OK/, "an ordinary snippet must survive hardening");
  assert.match(r.stdout, /app\.js:1/);
});

test("a traversal path outside the working directory is refused", () => {
  const dir = project();
  const outside = join(dir, "..", "wb-outside-canary.js");
  writeFileSync(outside, "const x = TRAVERSAL_CANARY;\n");
  try { refuses(run(dir, log("../wb-outside-canary.js")), /TRAVERSAL_CANARY/, /wb-outside-canary\.js:1/); }
  finally { rmSync(outside, { force: true }); }
});

test("an absolute path outside the working directory is refused", () => {
  const dir = project();
  const other = project();
  writeFileSync(join(other, "secret.js"), "const x = ABSOLUTE_CANARY;\n");
  refuses(run(dir, log(join(other, "secret.js"))), /ABSOLUTE_CANARY/, /secret\.js:1/);
});

if (canSymlink) {
  test("a file symlink pointing out of the tree is refused", () => {
    const dir = project();
    const other = project();
    writeFileSync(join(other, "secret.js"), "const x = FILE_LINK_CANARY;\n");
    symlinkSync(join(other, "secret.js"), join(dir, "innocent.js"));
    refuses(run(dir, log("innocent.js")), /FILE_LINK_CANARY/, /innocent\.js:1/);
  });

  test("a directory symlink pointing out of the tree is refused", () => {
    const dir = project();
    const other = project();
    mkdirSync(join(other, "vault"));
    writeFileSync(join(other, "vault", "secret.js"), "const x = DIR_LINK_CANARY;\n");
    symlinkSync(join(other, "vault"), join(dir, "lib"));
    refuses(run(dir, log("lib/secret.js")), /DIR_LINK_CANARY/, /secret\.js:1/);
  });

  test("a symlink that stays inside the tree is still read", () => {
    const dir = project();
    mkdirSync(join(dir, "real"));
    writeFileSync(join(dir, "real", "app.js"), "const x = INSIDE_LINK_OK;\n");
    symlinkSync(join(dir, "real", "app.js"), join(dir, "alias.js"));
    assert.match(run(dir, log("alias.js")).stdout, /INSIDE_LINK_OK/,
      "containment is about where a path lands, not how it got there");
  });

  test("a working directory reached through a symlink reads its own files", () => {
    const dir = project();
    writeFileSync(join(dir, "app.js"), "const x = VIA_LINKED_CWD;\n");
    const link = join(project(), "link");
    symlinkSync(dir, link);
    // The log names the file through the linked path, and the process runs there too.
    assert.match(run(link, log(join(link, "app.js"))).stdout, /VIA_LINKED_CWD/,
      "canonicalising both sides is what keeps this from rejecting its own tree");
  });
}

// ------------------------------------------------------------------- bounding

test("an oversized file is refused without printing it", () => {
  const dir = project();
  // 3 MiB, past the 2 MiB cap. fstat sees the size before a byte is allocated.
  writeFileSync(join(dir, "big.js"), "const x = OVERSIZE_CANARY;\n" + ("y".repeat(1023) + "\n").repeat(3 * 1024));
  refuses(run(dir, log("big.js")), /OVERSIZE_CANARY/, /big\.js:1/);
});

test("a file just under the cap is read normally", () => {
  const dir = project();
  writeFileSync(join(dir, "medium.js"), "// pad\n".repeat(1000) + "const x = UNDER_CAP_OK;\n");
  assert.match(run(dir, log("medium.js", 1001)).stdout, /UNDER_CAP_OK/);
});

test("an extremely long line is clamped, not printed whole", () => {
  const dir = project();
  writeFileSync(join(dir, "bundle.js"), "const x = LONG_LINE_HEAD;" + "y".repeat(200000) + ";\n");
  const r = run(dir, log("bundle.js"));
  const widest = Math.max(...r.stdout.split("\n").map((l) => l.length));
  assert.ok(widest < 2000, `a line of ${widest} characters reached the terminal`);
  assert.match(r.stdout, /LONG_LINE_HEAD/, "the head of the line is still shown");
});

// ------------------------------------------------------ directories and pipes

test("a directory named as a source file neither hangs nor prints", () => {
  const dir = project();
  mkdirSync(join(dir, "pkg.js"));
  const r = run(dir, log("pkg.js"));
  assert.notEqual(r.signal, "SIGTERM", "must exit rather than hang");
  assert.equal(r.status, 0);
  assert.match(r.stdout, /pkg\.js:1/);
});

if (platform() !== "win32") {
  test("a FIFO named as a source file does not block the process", () => {
    const dir = project();
    const fifo = join(dir, "pipe.js");
    if (spawnSync("mkfifo", [fifo]).status !== 0 || !existsSync(fifo)) {
      console.log("       (mkfifo unavailable — skipped)"); return;
    }
    // No writer will ever open this. Without O_NONBLOCK the open waits forever.
    const r = run(dir, log("pipe.js"));
    assert.notEqual(r.signal, "SIGTERM", "opening a FIFO for read blocked until the timeout");
    assert.equal(r.status, 0);
    assert.match(r.stdout, /pipe\.js:1/);
  });
}

// --------------------------------------------------------------- --no-source

test("--no-source reads no source file at all", () => {
  const dir = project();
  writeFileSync(join(dir, "app.js"), "const x = NO_SOURCE_CANARY;\n");
  assert.match(run(dir, log("app.js")).stdout, /NO_SOURCE_CANARY/, "the file is readable to begin with");
  const r = run(dir, log("app.js"), ["--no-source"]);
  assert.doesNotMatch(r.stdout, /NO_SOURCE_CANARY/);
  assert.match(r.stdout, /app\.js:1/, "the location is still reported");
});

test("--no-source survives a path that would be refused anyway", () => {
  const r = run(project(), log("../nothing-here.js"), ["--no-source"]);
  assert.equal(r.status, 0);
});

// ------------------------------------------------------- long-line rendering

// The window is a DISPLAY device. Clipping the line before comparison instead would
// answer "did this file change?" from a prefix, and an edit past the cut would read
// as no edit at all — the tool asserting code is current when it is not.
test("an edit past the display window is still detected as a change", () => {
  const dir = project();
  const shared = "a = " + "x".repeat(508);          // 512 identical characters
  writeFileSync(join(dir, "shop.py"), `${shared}CHANGED_ON_DISK\n`);
  const r = run(dir, pytestLog("shop.py", 1, `${shared}ORIGINAL_WHEN_RUN`));
  assert.match(r.stdout, /has changed since this ran/, "compared a prefix, not the line");
  assert.doesNotMatch(r.stdout, /CHANGED_ON_DISK/, "changed source must not be shown as current");
});

test("an unchanged long line is not reported as changed", () => {
  const dir = project();
  const line = "a = " + "x".repeat(2000);
  writeFileSync(join(dir, "shop.py"), `${line}\n`);
  const r = run(dir, pytestLog("shop.py", 1, line));
  assert.doesNotMatch(r.stdout, /has changed since this ran/, "width alone is not a change");
});

test("a caret deep in a long line stays beside the code it marks", () => {
  const dir = project();
  const line = "const a=1;" + "y".repeat(100000) + "; badExpr(oops)";
  writeFileSync(join(dir, "bundle.js"), `${line}\n`);
  const r = run(dir, log("bundle.js", 1, line.indexOf("badExpr") + 1));
  const lines = r.stdout.split("\n");
  const caret = lines.findIndex((l) => /^\s+│\s+\^/.test(l));
  assert.ok(caret > 0, "no caret was rendered");
  assert.ok(lines[caret].length < 400, `the caret line is ${lines[caret].length} characters wide`);
  // The window has to bring the reported column with it, not just cut the line short.
  const src = lines[caret - 1];
  assert.match(src, /badExpr\(oops\)/, "the offending expression must be inside the window");
  assert.equal(src[lines[caret].indexOf("^")], "b", "the caret does not point at badExpr");
});

// ------------------------------------------------------------ stale detection

test("a changed file is reported as changed rather than shown", () => {
  const dir = project();
  writeFileSync(join(dir, "shop.py"), "wholly_different_now = True\n");
  const r = run(dir, pytestLog("shop.py", 1, "assert total == 1050"));
  assert.match(r.stdout, /has changed since this ran/);
  assert.doesNotMatch(r.stdout, /wholly_different_now/, "showing it would be a lie");
});

test("an unchanged file still shows its source", () => {
  const dir = project();
  writeFileSync(join(dir, "shop.py"), "assert total == 1050\n");
  const r = run(dir, pytestLog("shop.py", 1, "assert total == 1050"));
  assert.doesNotMatch(r.stdout, /has changed since this ran/);
  assert.match(r.stdout, /assert total == 1050/);
});

test("an unreadable file is not mistaken for a changed one", () => {
  const r = run(project(), pytestLog("absent.py", 1, "assert total == 1050"));
  assert.doesNotMatch(r.stdout, /has changed since this ran/, "no file, so no claim about it");
  assert.match(r.stdout, /absent\.py:1/);
});

for (const dir of roots) rmSync(dir, { recursive: true, force: true });
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
