// Rust: cargo and rustc, cargo test, clippy.
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
  // Captured from real cargo runs. Three of the four are modes that are not "a test
  // failed", and the first is the most common Rust failure there is.
  { file: "cargo_panic_fail.txt", tool: "cargo", n: 1, check: (r) => {
      // PANIC_RE carries no `m` flag because it is matched line by line - and using it
      // in detect therefore only ever tested the FIRST line. A plain `cargo run` panic
      // has no "test result:" line to fall back on, so it produced nothing at all.
      assert.equal(r.failures[0].file, "src/main.rs");
      assert.equal(r.failures[0].line, 3);
      assert.match(r.failures[0].message, /index out of bounds: the len is 0 but the index is 3/);
      // This log IS a `cargo run` - it says "Running `target/debug/m2`" - and was
      // reported as "cargo test" for as long as the fixture has existed. A panic is a
      // test failure only when a test run is what produced it: a tally at the end, or a
      // per-test stdout block above it. This has neither.
      assert.equal(r.failures[0].category, "runtime");
      assert.equal(r.summary, "panicked");
    } },
  { file: "cargo_buildscript_fail.txt", tool: "cargo", n: 1, check: (r) => {
      // "failed to run custom build command" is the mechanism; the panic is the cause,
      // and cargo indents it under "--- stderr" so an anchored pattern missed it.
      assert.equal(r.summary, "build script failed");
      assert.equal(r.failures[0].file, "build.rs");
      assert.match(r.failures[0].message, /build script exploded/);
      assert.equal(r.failures[0].category, "build", "a build script is not a test");
      assert.doesNotMatch(JSON.stringify(r), /failed to run custom build command/);
    } },
  { file: "cargo_resolve_fail.txt", tool: "cargo", n: 1, check: (r) => {
      // A dependency that cannot be resolved never reaches the compiler, so there is no
      // E-code and no --> line for detection to key on.
      assert.match(r.failures[0].message, /no matching package named `this-crate-does-not-exist-xyz`/);
    } },
  { file: "cargo_manifest_fail.txt", tool: "cargo", n: 1, check: (r) => {
      assert.equal(r.failures[0].file, "Cargo.toml");
      assert.match(r.failures[0].message, /unclosed table, expected/);
    } },
  { file: "cargotest_fail.txt", tool: "cargo test", n: 2, check: (r) => {
      assert.equal(r.summary, "1 passed; 2 failed");   // zero-count noise dropped
      const f = r.failures.find((x) => x.title === "tests::invoice_total");
      assert.ok(f, "invoice_total not found");
      assert.equal(f.file, "src/lib.rs");
      assert.equal(f.line, 11);
      assert.match(f.message, /assertion `left == right` failed/);
      assert.match(f.message, /left: 1049/);
      assert.ok(!/RUST_BACKTRACE/.test(f.message), "backtrace note should be dropped");
    } },
  { file: "cargobuild_fail.txt", tool: "cargo", n: 3, check: (r) => {
      assert.equal(r.failures[0].title, "E0308");
      assert.equal(r.failures[0].file, "src/lib.rs");
      assert.equal(r.failures[0].line, 2);
      assert.match(r.failures[0].message, /expected `String`, found integer/);
      // E0277 prints 25 lines of trait impls from rustlib; none may leak through
      const e0277 = r.failures[1];
      assert.equal(e0277.title, "E0277");
      assert.equal(e0277.line, 3);
      assert.ok(!/rustlib|internal_macros/.test(e0277.message), "rustlib noise leaked");
      assert.ok(r.failures.every((f) => !/could not compile/.test(f.message)),
        "the error tally must not be counted as an error");
    } },
  // The same failing crate captured twice: once as cargo prints it, and once under
  // `--message-format=json`, which nothing here could read a word of. Every diagnostic
  // record in that stream carries the human text rustc would otherwise have printed,
  // verbatim, under message.rendered - so the JSON needs no parser of its own, only to
  // be handed to the one that already reads cargo. The pair is what proves it: both
  // must reach the same three failures, or the JSON path is inventing something.
  { file: "cargo_plain_same_fail.txt", tool: "cargo", n: 3, check: (r) => {
      assert.deepEqual(r.failures.map((f) => [f.line, f.code]), [[2, "E0308"], [3, "E0425"], [4, "E0308"]]);
    } },
  { file: "cargo_json_fail.txt", tool: "cargo", n: 3, check: (r) => {
      assert.deepEqual(r.failures.map((f) => [f.line, f.code]), [[2, "E0308"], [3, "E0425"], [4, "E0308"]]);
      assert.equal(r.failures[0].file, "src/main.rs");
      assert.equal(r.failures[0].col, 18, "the primary span is the place rustc wants you to look");
      // The span carries the offending line, so what is quoted is rustc's own text.
      assert.equal(r.failures[0].stmt, '    let x: i32 = "no";');
      // Records that are not diagnostics - compiler-artifact, build-finished - and the
      // failure-notes rustc ends with are not failures and are not scraped for words.
      assert.doesNotMatch(JSON.stringify(r.failures), /compiler-artifact|"reason"|detailed explanations/);
    } },
  { file: "cargotest_snapshot_fail.txt", tool: "cargo test", n: 3, check: (r) => {
      // real `cargo test` run of clap-rs/clap after renaming the "Usage:" prefix.
      // snapbox prints a diff whose CONTEXT lines carry both line numbers and a bar;
      // those are the parts that matched, and keeping them filled the four-line
      // message budget before reaching the -/+ lines that say what changed.
      assert.equal(r.summary, "824 passed; 88 failed");
      for (const f of r.failures) {
        assert.ok(!/^\s*\d+\s+\d+\s*\|/m.test(f.message ?? ""),
          `a diff context line survived: ${JSON.stringify(f.message)}`);
      }
      assert.match(r.failures[0].message, /- Usage:/, "the removed line must be shown");
      assert.match(r.failures[0].message, /\+ Syntax:/, "the added line must be shown");
      assert.match(r.failures[0].file, /conflicts\.rs$|app_settings\.rs$|subcommands\.rs$/);
    } },
  { file: "clippy_fail.txt", tool: "cargo", n: 15, check: (r) => {
      // real `cargo clippy -- -D warnings` on clap-rs/clap, the way CI runs it.
      // clippy diagnostics carry no E-code, so every one of them was untitled. The
      // lint name is the handle you actually want - it is what you search for and
      // what goes in an #[allow(...)].
      assert.equal(r.failures.filter((f) => !f.title).length, 0, "every clippy error must name its lint");
      // `warning: lint `clippy::from_iter_instead_of_collect` has been removed` - once,
      // and once more for clap_builder, which cargo counts as "(1 duplicate)".
      assert.equal(r.summary, "15 errors — 1 warning hidden");
      const lints = new Set(r.failures.map((f) => f.title));
      assert.ok(lints.has("clippy::needless_return"), [...lints].join(","));
      assert.ok(lints.has("clippy::ptr_arg"));
      // the "-D clippy::name" note appears once per lint, so repeats would come out
      // untitled; the doc-link fragment appears on every diagnostic
      assert.equal(r.failures.filter((f) => f.title === "clippy::needless_return").length, 6);
      // one lint in several places is one thing to fix
      const reported = r.clusters.filter((c) => c.reported);
      assert.ok(reported.length >= 3, `expected a cause per lint, got ${reported.length}`);
    } },
  // cargo --message-format=short puts the whole diagnostic on one line and drops the
  // "-->" beneath it. The fallback made three failures of two, counting the tally.
  { file: "cargo_human_same_fail.txt", tool: "cargo", n: 2, check: (r) => {
      assert.deepEqual(r.failures.map((f) => [f.file, f.line, f.code]), [
        ["src/main.rs", 3, "E0425"], ["src/main.rs", 2, "E0308"],
      ]);
      // `|                ---   ^^^^^^^^^^^^^^ expected `i32`, found `&str`` - two spans on
      // one row. The label is what follows the last of them, not the first.
      assert.equal(r.failures[1].message, "mismatched types\nexpected `i32`, found `&str`");
    } },
  { file: "cargo_short_fail.txt", tool: "cargo", n: 2, check: (r) => {
      assert.deepEqual(r.failures.map((f) => [f.file, f.line, f.col, f.code]), [
        ["src/main.rs", 3, 20, "E0425"], ["src/main.rs", 2, 22, "E0308"],
      ]);
      assert.doesNotMatch(JSON.stringify(r.failures), /could not compile/,
        "the tally is not a third error");
    } },
  // One real `cargo build --all-targets` in each --message-format: two errors, a warning
  // with a location, and a warning with none (`-W no_such_lint`). The library and the
  // binary are each compiled twice, once for their tests, so every diagnostic is emitted
  // twice. The text forms print each once and say "(1 duplicate)"; the JSON stream
  // carries every copy.
  { file: "cargo_warnings_human_fail.txt", tool: "cargo", n: 2, check: (r) => {
      assert.equal(r.summary, "2 errors — 2 warnings hidden");
    } },
  { file: "cargo_warnings_short_fail.txt", tool: "cargo", n: 2, check: (r) => {
      assert.equal(r.summary, "2 errors — 2 warnings hidden");
    } },
  { file: "cargo_warnings_json_fail.txt", tool: "cargo", n: 2, check: (r) => {
      // It said "4 errors - 6 warnings hidden" above the two failures that survived.
      const records = fx("cargo_warnings_json_fail.txt").split("\n").filter((l) => l.startsWith("{"))
        .map((l) => JSON.parse(l)).filter((x) => x.reason === "compiler-message");
      assert.equal(records.filter((x) => x.message.level === "error").length, 4, "the fixture repeats each error");
      assert.equal(r.summary, "2 errors — 2 warnings hidden");
    } },
];

let pass = 0, fail = 0;
for (const result of [runCases(CASES), agreeAcrossFormats([
  ["cargo warnings", ["cargo_warnings_human_fail.txt", "cargo_warnings_json_fail.txt"]],
  // --message-format=short joins the label onto the message with a colon.
  ["cargo warnings short", ["cargo_warnings_human_fail.txt", "cargo_warnings_short_fail.txt"], ["message"]],
])]) {
  pass += result.pass;
  fail += result.fail;
}


// These two fixtures are one `cargo build` captured both ways, and the failures they
// produce have to match field for field - otherwise the JSON path is not reading cargo,
// it is guessing at it.
try {
  const plain = analyse(fx("cargo_plain_same_fail.txt"));
  const json = analyse(fx("cargo_json_fail.txt"));
  // The facts have to be identical. The rendering does not: the text format draws a run
  // of carets under the primary span, and that is a picture of the columns rather than
  // anything the JSON says, so this does not synthesise one from them.
  const facts = (r) => r.failures.map((f) => [f.file, f.line, f.col, f.code, f.severity, f.stmt]);
  assert.equal(plain.tool, json.tool);
  assert.deepEqual(facts(json), facts(plain),
    "the JSON stream and the text cargo printed disagree about what failed");
  // Equal, not "ends with": the text form's label was read as "^^^^ expected `i32`,
  // found `&str`" - the primary span's carets and all, because rustc drew a secondary
  // span's dashes earlier on the same row - and that still ended with the JSON's label.
  for (const [i, f] of json.failures.entries()) {
    assert.ok(f.message.includes("\n"), `failure ${i}: the JSON form has no label`);
    assert.equal(plain.failures[i].message, f.message,
      `failure ${i}: the message differs between the two formats`);
  }
  console.log("  ok   --message-format=json says what the text cargo printed says");
  pass++;
} catch (e) { console.log(`  FAIL cargo json vs text\n       ${e.message}`); fail++; }

// How many warnings a cargo run hid is cargo's own number, whichever format printed it.
// cargo ends each crate with "`shop` (lib) generated 2 warnings (1 duplicate)", and the
// ones it did not print again are the duplicates - so the warnings shown are the sum of
// the one less the other. The JSON stream prints no such line, and has to agree anyway.
try {
  const tallied = (name) => [...fx(name).matchAll(/generated (\d+) warnings?(?: \((\d+) duplicates?\))?/g)]
    .reduce((n, m) => n + +m[1] - +(m[2] ?? 0), 0);
  const hidden = (name) => +(analyse(fx(name)).summary.match(/(\d+) warnings? hidden/)?.[1] ?? 0);
  for (const name of ["cargo_warnings_human_fail.txt", "cargo_warnings_short_fail.txt", "clippy_fail.txt"]) {
    assert.ok(tallied(name) > 0, `${name}: cargo tallied no warnings`);
    assert.equal(hidden(name), tallied(name), `${name}: the summary disagrees with cargo's own tally`);
  }
  assert.equal(hidden("cargo_warnings_json_fail.txt"), hidden("cargo_warnings_human_fail.txt"));
  console.log("  ok   cargo's hidden warnings are cargo's own count, in every format");
  pass++;
} catch (e) { console.log(`  FAIL cargo hidden warnings\n       ${e.message}`); fail++; }

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
