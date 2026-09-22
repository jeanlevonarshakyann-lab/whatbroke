// The generic reader, for output no parser recognises.
//
// Each case is a real capture in test/fixtures/, read the way whyitbroke reads it; each
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


// whyitbroke wraps any command, not only test runners. A shell script that fails
// prints the classic unix shape, and none of it was recognised.
try {
  const shouldMatch = [
    "curl: (7) Failed to connect to 127.0.0.1 port 9 after 0 ms: Could not connect to server",
    "cp: cannot stat 'x': No such file or directory",
    "ssh: connect to host example.com port 22: Connection refused",
    "bash: line 5: deploy: command not found",
    // `set -u` is how a careful CI script is written, and nothing else in what the shell
    // says about it reads as a failure at all.
    "deploy.sh: line 4: FOO: unbound variable",
    // sed and awk say this, and so do several compilers
    "sed: -e expression #1, char 3: unterminated address regex",
    "awk: cmd. line:1: unterminated string",
    // Go writes its errors as what it was doing, then why it could not, and everything
    // built on Go writes them the same way - `docker compose` says most of its failures
    // in this form. What it was doing is words, so a colon inside one of them ends the
    // search: "dial tcp 10.0.0.1:80: connect: connection refused" is still not read.
    "open /app/compose.yaml: no such file or directory",
    "loading compose project: invalid compose file",
    "creating network shop_default: permission denied",
  ];
  const shouldNot = [
    "Deploying to staging...",
    // What it was doing is a few words, not a sentence. A whole clause before the colon
    // is prose, and prose mentions these words without being a diagnostic - this line is
    // a build system saying what it chose to skip, and it holds "not found".
    "Running tests in /app: everything is fine",
    // Past a few words it is prose, and prose carries this vocabulary while saying the
    // opposite: both of these are a build reporting it found nothing wrong.
    "restored 4 workspaces from the cache: nothing missing",
    "checked 31 files in src and test: no errors",
    "note: this is fine",
    "info: everything is working",
    "warning: deprecated flag",
  ];
  for (const l of shouldMatch) {
    const r = analyse(`Starting\n${l}\n`);
    assert.ok(r?.failures.length, `should have recognised: ${l}`);
    assert.match(r.failures[0].message, /Failed|cannot|refused|not found|unbound|unterminated|no such|invalid|permission/i);
  }
  for (const l of shouldNot) {
    // a bare "prog: message" must not be treated as a failure just for having a colon
    assert.ok(!analyse(`Starting\n${l}\n`), `should have ignored: ${l}`);
  }
  console.log("  ok   plain unix errors are recognised, ordinary log lines are not");
  pass++;
} catch (e) { console.log(`  FAIL unix error shape\n       ${e.message}`); fail++; }

// A tool that exits 0 having only warned did not fail, and the fallback saying it did
// three times is the worst thing this parser can do. The severity word after a location
// is what says so - but the colon behind it is not always the next character, because a
// linter that reports which rule fired names the rule in between. These lines are real
// output: oxlint 1.x, clang 17 and javac 21.
try {
  const aside = [
    "shop.js:1:7: warning eslint(no-unused-vars): Variable 'unused' is declared but never used.",
    "shop.js:4:3: warning eslint(no-debugger): `debugger` statement is not allowed",
    "warn.c:4:14: warning: more '%' conversions than data arguments [-Wformat-insufficient-args]",
    "warn.c:3:10: note: initialize the variable 'x' to silence this warning",
    "Orders.java:8: warning: [rawtypes] found raw type: List",
  ];
  for (const l of aside) {
    assert.ok(!analyse(`Starting\n${l}\n`), `a warning is not a failure: ${l}`);
  }
  // ...and the same shape at error severity still is, rule name and all. Widening the
  // aside until it swallowed these would trade one silent lie for a louder one.
  const real = [
    "shop.js:1:7: error eslint(no-unused-vars): Variable 'unused' is declared but never used.",
    "bad.c:3:13: error: incompatible pointer to integer conversion",
    // The word alone does not make an aside: what follows a real severity is prose, and
    // prose is how you tell it from a rule name.
    "deploy.sh:2:1: warning handling failed catastrophically: the build is dead",
  ];
  for (const l of real) {
    assert.ok(analyse(`Starting\n${l}\n`)?.failures.length, `should still be read: ${l}`);
  }
  console.log("  ok   a located warning is an aside, whether or not it names its rule");
  pass++;
} catch (e) { console.log(`  FAIL located aside\n       ${e.message}`); fail++; }

// A tool refusing an argument is what a typo'd flag in a CI script produces, and every
// one of these is what the tool really prints. Most name themselves; docker and python
// name themselves nowhere, so for those the refusal has to open the line.
try {
  const refused = [
    "curl: option --nosuchflag: is unknown",
    "awk: unknown option --nosuchflag ignored",
    "jq: Unknown option --nosuchflag",
    "node: bad option: --nosuchflag",
    "unknown flag: --nosuchflag",
    "unknown option --nosuchflag",
  ];
  for (const l of refused) {
    assert.ok(analyse(`Starting\n${l}\n`)?.failures.length, `should have recognised: ${l}`);
  }
  // The same words mid-sentence are prose. Across 1,498 lines of real --help output from
  // twelve tools neither form matched once, which is why the bare one must open the line.
  for (const l of ["the unknown option space is large and that is fine",
    "documents every unknown flag we could find: none",
    "Deploying with an unknown option count..."]) {
    assert.ok(!analyse(`Starting\n${l}\n`), `should have ignored: ${l}`);
  }
  console.log("  ok   a tool refusing an argument says so, named or not");
  pass++;
} catch (e) { console.log(`  FAIL refused argument\n       ${e.message}`); fail++; }
// A program is as often named by its path as by its name. A shell says
// "/bin/sh: nosuchcommand: not found", env says "/usr/bin/env: node: No such file or
// directory", and Docker BuildKit quotes the first of those for every RUN that fails -
// which is the cause of the build failing, under BuildKit's own line saying it did.
// Requiring the line to start with the program's name meant none of them were read.
try {
  const byPath = [
    "/bin/sh: nosuchcommand: not found",
    "/usr/bin/env: node: No such file or directory",
    "/bin/bash: line 3: deploy: command not found",
    "./scripts/deploy.sh: permission denied",
  ];
  for (const l of byPath) {
    const r = analyse(`Starting\n${l}\n`);
    assert.ok(r?.failures.length, `should have recognised: ${l}`);
  }
  // ...and the vocabulary is still what keeps an ordinary path with a colon after it out,
  // which is the whole reason the line could not simply start with anything.
  for (const l of ["/home/dev/app.py: all is well", "src/main.rs: nothing wrong here",
    "/etc/hosts: 127.0.0.1 localhost"]) {
    assert.ok(!analyse(`Starting\n${l}\n`), `should have ignored: ${l}`);
  }
  console.log("  ok   a program named by its path reports failures like any other");
  pass++;
} catch (e) { console.log(`  FAIL program named by path\n       ${e.message}`); fail++; }

// A launcher relaying the exit status of what it ran is a consequence, not a cause - the
// same thing make's `*** [all] Error 1` is, which make's own parser has never read. It is
// dropped only while there is a cause for it to be the consequence of.
try {
  const relayed = 'ERROR: failed to build: failed to solve: process "/bin/sh -c exit 3" did not complete successfully: exit code: 3';
  const cause = "/bin/sh: nosuchcommand: not found";

  const both = analyse(`Starting\n${cause}\n${relayed}\n`);
  assert.equal(both?.failures.length, 1, "the restatement is not a second failure");
  assert.match(both.failures[0].message, /nosuchcommand: not found/, "the cause is what leads");

  // And when nothing else was found it is the only account of the failure there is -
  // `RUN exit 3` prints nothing at all. docker's own parser takes that case, but a
  // fragment of a log that reaches the fallback without it must not come back empty.
  const alone = analyse(`Starting\n${relayed}\n`);
  assert.equal(alone?.failures.length, 1, "the only account of a failure is still reported");
  assert.match(alone.failures[0].message, /did not complete successfully/);

  console.log("  ok   a relayed exit status is dropped as a consequence, kept as a last account");
  pass++;
} catch (e) { console.log(`  FAIL relayed exit status\n       ${e.message}`); fail++; }

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
