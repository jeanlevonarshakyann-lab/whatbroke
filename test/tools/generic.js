// The generic reader, for output no parser recognises.
//
// Each case is a real capture in test/fixtures/, read the way whatbroke reads it; each
// format group is one run captured in several formats, which have to agree. The checks
// below them are about how this family's tools print what they print.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { analyse } from "../../src/index.js";
import { agreeAcrossFormats, cli, fx, here, runCases } from "./harness.js";

const CASES = [
  // Two real captures of everyday unix failures, both of which produced no diagnosis at
  // all. The guess vocabulary was written around verbs - failed, cannot, refused - and
  // missed the nouns. Both tools name themselves and then say plainly that something
  // broke; the word just is not immediately in front of a colon, so nothing fired.
  { file: "tar_format_fail.txt", tool: "output", n: 1, check: (r) => {
      assert.match(r.failures[0].message, /^tar: Error opening archive: Unrecognized archive format$/);
      assert.ok(r.guessed, "a guess must say it is one");
    } },
  { file: "awk_syntax_fail.txt", tool: "output", n: 2, check: (r) => {
      assert.match(r.failures[0].message, /^awk: syntax error at source line 1$/);
      assert.match(r.failures[1].message, /^awk: illegal statement at source line 1$/);
      // "context is" and the echoed source under it are the drawing, not the diagnosis
      assert.doesNotMatch(JSON.stringify(r.failures), /context is/);
    } },
  // Neither has a parser, and neither should: they are here to hold the fallback to a
  // standard. Both used to come back as nothing at all, because the pattern that spots
  // "Error:" required a capital E and these tools write it lower.
  { file: "jq_fail.txt", tool: "output", n: 1, check: (r) => {
      assert.equal(r.guessed, true, "a guess must say it is one");
      assert.match(r.failures[0].message, /parse error: Expected another key-value pair at line 1, column 11/);
    } },
  { file: "openssl_fail.txt", tool: "output", n: 1, check: (r) => {
      assert.equal(r.guessed, true);
      assert.match(r.failures[0].message, /PEM routines/);
      assert.doesNotMatch(r.failures[0].message, /^unable to load certificate$/,
        "the line naming the routine says more than the one-line summary above it");
    } },
];

let pass = 0, fail = 0;
for (const result of [runCases(CASES)]) {
  pass += result.pass;
  fail += result.fail;
}


// whatbroke wraps any command, not only test runners. A shell script that fails
// prints the classic unix shape, and none of it was recognised.
try {
  const shouldMatch = [
    "curl: (7) Failed to connect to 127.0.0.1 port 9 after 0 ms: Could not connect to server",
    "cp: cannot stat 'x': No such file or directory",
    "ssh: connect to host example.com port 22: Connection refused",
    "bash: line 5: deploy: command not found",
  ];
  const shouldNot = [
    "Deploying to staging...",
    "note: this is fine",
    "info: everything is working",
    "warning: deprecated flag",
  ];
  for (const l of shouldMatch) {
    const r = analyse(`Starting\n${l}\n`);
    assert.ok(r?.failures.length, `should have recognised: ${l}`);
    assert.match(r.failures[0].message, /Failed|cannot|refused|not found/i);
  }
  for (const l of shouldNot) {
    // a bare "prog: message" must not be treated as a failure just for having a colon
    assert.ok(!analyse(`Starting\n${l}\n`), `should have ignored: ${l}`);
  }
  console.log("  ok   plain unix errors are recognised, ordinary log lines are not");
  pass++;
} catch (e) { console.log(`  FAIL unix error shape\n       ${e.message}`); fail++; }

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
