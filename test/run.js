import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { analyse } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n) => readFileSync(join(here, "fixtures", n), "utf8");
const cli = join(here, "..", "bin", "whatbroke.js");

const CASES = [
  { file: "pytest_fail.txt", tool: "pytest", n: 3, check: (r) => {
      assert.match(r.summary, /3 failed, 2 passed/);
      const f = r.failures[0];
      assert.equal(f.title, "test_invoice_total");
      assert.equal(f.line, 4);
      assert.match(f.file, /test_shop\.py$/);
      assert.match(f.message, /assert 1049 == 1050/);
      assert.equal(r.failures[1].message, "KeyError: 'exp'");
      assert.equal(r.failures[2].title, "test_param[2]");
    } },
  { file: "py_unittest.txt", tool: "unittest", n: 2, check: (r) => {
      assert.match(r.summary, /Ran 3 tests/);
      assert.ok(r.failures.some((f) => /1049 != 1050/.test(f.message)));
      assert.ok(r.failures.every((f) => f.line > 0));
    } },
  { file: "py_traceback.txt", tool: "python", n: 1, check: (r) => {
      const f = r.failures[0];
      assert.equal(f.message, "KeyError: 'taxrate'");
      assert.equal(f.line, 6);          // deepest USER frame, not the entrypoint
      assert.equal(f.title, "main");
    } },
  { file: "node_stack.txt", tool: "node", n: 1, check: (r) => {
      const f = r.failures[0];
      assert.equal(f.title, "TypeError");
      assert.match(f.message, /Cannot read properties of null/);
      assert.equal(f.line, 1);
      assert.ok(f.hiddenFrames >= 5, "node internals should be hidden");
      assert.ok(f.trace.every((t) => !/node:internal/.test(t)));
    } },
  { file: "tsc_plain.txt", tool: "tsc", n: 3, check: (r) => {
      assert.equal(r.failures[0].title, "TS2551");
      assert.equal(r.failures[0].line, 2);
      assert.equal(r.failures[0].col, 52);
      assert.match(r.summary, /3 errors in 1 file/);
    } },
  { file: "node_eval.txt", tool: "node", n: 1, check: (r) => {
      const f = r.failures[0];
      assert.equal(f.title, "TypeError");
      assert.equal(f.file, "[eval]");
      assert.equal(f.stmt, "null.x");
      // node's own eval wrapper must never be shown as user code
      assert.ok(!f.trace.some((t) => /\[eval\]-wrapper|node:internal/.test(t)),
        `wrapper frame leaked: ${JSON.stringify(f.trace)}`);
      assert.equal(f.hiddenFrames, 7);
    } },
  { file: "vitest_fail.txt", tool: "vitest", n: 3, check: (r) => {
      assert.match(r.summary, /3 failed \| 1 passed/);
      const f = r.failures[0];
      assert.equal(f.title, "invoice total");
      assert.equal(f.line, 3);
      assert.equal(f.col, 62);
      assert.match(f.message, /expected 1049 to be 1050/);
      assert.match(f.message, /1050/);          // keeps the expected/received diff
      assert.equal(r.failures[2].title, "throws");
      assert.match(r.failures[2].message, /TypeError/);
    } },
  { file: "eslint_fail.txt", tool: "eslint", n: 3, check: (r) => {
      // warnings are not errors: 4 problems reported, 3 shown
      assert.match(r.summary, /1 warning hidden/);
      assert.equal(r.failures[0].title, "no-unused-vars");
      assert.equal(r.failures[0].line, 1);
      assert.equal(r.failures[0].col, 7);
      assert.ok(r.failures.every((f) => /messy\.js$/.test(f.file)), "file must attach to each problem");
      assert.equal(r.failures[2].title, "no-undef");
    } },
  { file: "jest_fail.txt", tool: "jest", n: 2, check: (r) => {
      assert.match(r.summary, /2 failed, 1 passed/);
      const f = r.failures[0];
      assert.equal(f.title, "invoice total");
      assert.equal(f.file, "sum.test.js");
      assert.equal(f.line, 2);
      assert.match(f.message, /toBe\(expected\)/);
      assert.match(f.message, /Expected: 1050/);
      assert.match(f.message, /Received: 1049/);
      assert.equal(r.failures[1].title, "expired token");
    } },
  { file: "gotest_fail.txt", tool: "go test", n: 3, check: (r) => {
      assert.match(r.summary, /3 tests failed/);
      assert.equal(r.failures[0].title, "TestInvoiceTotal");
      assert.equal(r.failures[0].line, 8);
      assert.match(r.failures[0].message, /Total\(\) = 1049, want 1050/);
      const panic = r.failures[2];
      assert.equal(panic.title, "TestPanics");
      assert.match(panic.message, /panic: assignment to entry in nil map/);
      // must resolve past Go's runtime/testing frames to the user's line
      assert.equal(panic.line, 27);
      assert.match(panic.file, /shop_test\.go$/);
    } },
  { file: "gobuild_fail.txt", tool: "go build", n: 3, check: (r) => {
      assert.match(r.summary, /3 compile errors/);
      assert.equal(r.failures[0].file, "broken.go");   // leading "./" stripped
      assert.equal(r.failures[0].line, 4);
      assert.equal(r.failures[0].col, 17);
      assert.match(r.failures[1].message, /undefined: undefinedCall/);
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
  { file: "gosub_fail.txt", tool: "go test", n: 2, check: (r) => {
      // the parent "--- FAIL: TestTable" is a container, not a third failure
      assert.equal(r.summary, "2 tests failed");
      assert.equal(r.failures[0].title, "TestTable/one");
      assert.equal(r.failures[0].file, "sub_test.go");
      assert.equal(r.failures[0].line, 18);
      assert.match(r.failures[0].message, /Total\(\[5\]\) = 5, want 6/);
      assert.equal(r.failures[1].title, "TestTable/many");
      assert.ok(!r.failures.some((f) => f.title === "TestTable"), "parent must not be reported");
    } },
  { file: "ruff_fail.txt", tool: "ruff", n: 4, check: (r) => {
      assert.equal(r.summary, "4 errors");
      assert.equal(r.failures[0].title, "F401");
      assert.equal(r.failures[0].file, "messy.py");
      assert.equal(r.failures[0].line, 1);
      assert.equal(r.failures[0].col, 8);
      assert.match(r.failures[0].message, /`os` imported but unused/);
      assert.match(r.failures[0].message, /Remove unused import/);  // keeps ruff's fix hint
      assert.equal(r.failures[3].title, "E711");
      // ruff and cargo share the " --> file:line:col" shape; they must not cross-detect
      const cargo = analyse(fx("cargobuild_fail.txt"));
      assert.equal(cargo.tool, "cargo", "cargo output must not be claimed by ruff");
    } },
  { file: "mypy_fail.txt", tool: "mypy", n: 3, check: (r) => {
      assert.equal(r.summary, "3 errors in 1 file");          // "1 file", not "1 files"
      assert.equal(r.failures[0].file, "typed.py");
      assert.equal(r.failures[0].line, 2);
      assert.equal(r.failures[0].title, "return-value");       // mypy's [code] becomes the title
      assert.match(r.failures[2].message, /Argument 1 to "total"/);
      assert.ok(!r.failures.some((f) => /note:/.test(f.message)), "notes are not errors");
    } },
  { file: "clang_fail.txt", tool: "clang", n: 2, check: (r) => {
      assert.equal(r.failures[0].title, "-Wint-conversion");
      assert.equal(r.failures[0].col, 17);
      // an error with no [-Wflag] must still be clang's, not claimed by mypy
      assert.equal(r.failures[1].title, "error");
      assert.match(r.failures[1].message, /use of undeclared identifier 'y'/);
      assert.equal(r.tool, "clang", "clang output must not be claimed by the mypy parser");
    } },
  { file: "rspec_fail.txt", tool: "rspec", n: 2, check: (r) => {
      assert.equal(r.summary, "3 examples, 2 failures");
      assert.equal(r.failures[0].title, "shop totals an invoice");
      assert.equal(r.failures[0].file, "./spec/shop_spec.rb");
      assert.equal(r.failures[0].line, 7);
      // the KeyError frame list has two entries; the deepest user line wins
      assert.equal(r.failures[1].line, 12);
      assert.match(r.failures[1].message, /key not found: "exp"/);
    } },
  { file: "maven_fail.txt", tool: "maven", n: 2, check: (r) => {
      // maven prints every error twice; the second copy must be collapsed
      assert.equal(r.failures.length, 2);
      assert.match(r.failures[0].file, /Shop\.java$/);
      assert.equal(r.failures[0].line, 4);
      assert.equal(r.failures[0].col, 20);
      assert.match(r.failures[1].message, /cannot find symbol/);
    } },
  { file: "gradle_fail.txt", tool: "gradle", n: 2, check: (r) => {
      // real gradle javac output, printed once plainly and once indented under
      // "What went wrong" - both copies must collapse to two failures
      assert.equal(r.failures.length, 2);
      assert.match(r.failures[0].file, /Shop\.java$/);
      assert.equal(r.failures[0].line, 4);
      assert.match(r.failures[0].message, /incompatible types/);
      assert.equal(r.tool, "gradle", "gradle javac output must not be claimed by mypy");
    } },
  { file: "gradle_java_fail.txt", tool: "gradle", n: 2, check: (r) => {
      assert.equal(r.summary, "build failed");
      assert.equal(r.failures[0].file, "/workspace/src/main/java/com/acme/Invoice.java");
      assert.equal(r.failures[0].line, 18);
      assert.equal(r.failures[0].col, undefined);
      assert.match(r.failures[1].message, /cannot find symbol/);
    } },
  { file: "dotnet_fail.txt", tool: "dotnet", n: 2, check: (r) => {
      // dotnet prints each error twice; summary and list must agree
      assert.equal(r.summary, "2 errors");
      assert.equal(r.failures.length, 2);
      assert.equal(r.failures[0].title, "CS0029");
      assert.equal(r.failures[0].line, 5);
      // the trailing [/path/app.csproj] is noise, not part of the message
      assert.ok(!r.failures.some((f) => /csproj/.test(f.message)),
        "the project path must be stripped from the message");
    } },
  { file: "phpunit_fail.txt", tool: "phpunit", n: 2, check: (r) => {
      assert.equal(r.summary, "2 failures");
      assert.equal(r.failures[0].title, "ShopTest::testInvoiceTotal");
      assert.equal(r.failures[0].line, 8);
      assert.match(r.failures[0].message, /1049 is identical to 1050/);
      // the trailing "FAILURES! / Tests: 3, Assertions: 3" must not land in a message
      assert.ok(!r.failures.some((f) => /FAILURES!|Assertions:/.test(f.message)),
        "the run summary must not be absorbed into the last failure");
    } },
  { file: "gotest_cluster_fail.txt", tool: "go test", n: 7, check: (r) => {
      // real `go test` run of spf13/cobra after renaming one error string.
      // Three tests share one assertion shape; the rest fail differently.
      const reported = r.clusters.filter((c) => c.reported);
      assert.equal(reported.length, 1, "the shared cause should be one cluster");
      assert.equal(reported[0].size, 3);
      assert.match(reported[0].signature, /Expected: <str>, got: <str>/);
      assert.ok(reported[0].members.every((i) => /args_test\.go$/.test(r.failures[i].file)),
        "all three sites are in args_test.go");
      // and the four unrelated failures must NOT have been swept in
      assert.equal(r.clusters.filter((c) => !c.reported).length, 4);
    } },
  { file: "vitest_cluster_fail.txt", tool: "vitest", n: 3, check: (r) => {
      // real vitest run of pillarjs/path-to-regexp after making a trailing-delimiter
      // group mandatory. vitest labels its diff "- Expected:" / "+ Received:" WITH a
      // colon; those headers must never survive as message content, because without
      // their values they promise a diff and show none.
      assert.equal(r.summary, "191 failed | 293 passed (484)");
      for (const f of r.failures) {
        assert.ok(!/^[-+]\s*(Expected|Received):?\s*$/m.test(f.message ?? ""),
          `a bare diff header leaked into a message: ${JSON.stringify(f.message)}`);
      }
      assert.match(r.failures[0].message, /expected false to deeply equal/);
      assert.equal(r.failures[0].file, "src/index.spec.ts");
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
  { file: "maven_test_fail.txt", tool: "maven", n: 1, check: (r) => {
      // real `mvn test` on stleary/JSON-java after changing one exception message.
      // Surefire test failures used to fall through to a counter - "Tests run: 164,
      // Failures: 1" - which names no test, no line and no assertion.
      assert.equal(r.summary, "Tests run: 792, Failures: 1, Errors: 0, Skipped: 6",
        "the run total, not the first per-class line");
      const f = r.failures[0];
      assert.equal(f.title, "JSONObjectTest.jsonObjectNonAndWrongValues");
      assert.equal(f.file, "JSONObjectTest.java");
      assert.equal(f.line, 1055);
      assert.match(f.message, /expected:<.*not found.*> but was:<.*is absent.*>/);
      assert.ok(!/Tests run:/.test(f.message), "the counter is a summary, not a failure message");
    } },
  { file: "dotnettest_fail.txt", tool: "dotnet test", n: 3, check: (r) => {
      // real `dotnet test` (Microsoft.Testing.Platform + xUnit) on khellang/Scrutor
      // after changing one default lifetime. This output used to fall through to the
      // generic guess: one "error", no test name, no file, no line.
      assert.equal(r.summary, "3 failed, 77 passed (80)");
      const f = r.failures[0];
      assert.equal(f.title, "ScanningTests.AutoRegisterAsMatchingInterface");
      assert.match(f.file, /ScanningTests\.cs$/);
      assert.equal(f.line, 395);
      assert.match(f.message, /Assert\.All\(\) Failure/);
      // the runner prints each message twice, plainly and re-indented under "from"
      assert.equal((f.message.match(/Assert\.All\(\) Failure/g) || []).length, 1,
        "the repeated copy of the message must not be collected");
      // and the location must come from the user's frame, not the reflection runner
      assert.ok(r.failures.every((g) => !/System\.Reflection/.test(g.file ?? "")));
      assert.equal(r.failures[2].line, 152);
    } },
  { file: "jest_snapshot_fail.txt", tool: "jest", n: 1, check: (r) => {
      // real jest run of testing-library/jest-dom after inverting one matcher.
      assert.equal(r.summary, "94 failed, 538 passed, 632 total");
      const f = r.failures[0];
      // "FAIL jsdom src/a.js" - with multiple jest projects the display name comes
      // first, and taking the first token made every file the project name
      assert.equal(f.file, "src/__tests__/to-contain-html.js");
      assert.equal(f.line, 104);
      // jest uses the same bullet for config complaints as for failed tests
      assert.ok(!/Validation Warning|watchPlugins/.test(f.title + f.message),
        "a config warning must not be reported as a failed test");
      // a snapshot diff opens with count headers and a hunk header, and restates
      // the test name; none of those are the diff
      assert.ok(!/^[-+]\s*(Snapshot|Received)\s+[-+]\s*\d+$/m.test(f.message), "count header kept");
      assert.ok(!/^@@ /m.test(f.message), "hunk header kept");
      assert.ok(!/^Snapshot name:/m.test(f.message), "the title was restated in the message");
      assert.match(f.message, /toContainHTML/);

      // The file usually comes from the stack frame; the "FAIL <project> <path>"
      // header is the fallback when there is no frame. Strip the frames from this
      // same real output to exercise it - otherwise the fallback is never tested,
      // and with several jest projects it yielded the project name as the filename.
      const frameless = fx("jest_snapshot_fail.txt").split("\n").filter((l) => !/^\s+at /.test(l)).join("\n");
      const g = analyse(frameless).failures[0];
      assert.equal(g.file, "src/__tests__/to-contain-html.js",
        "with no stack frame the FAIL header must yield the path, not the project name");
    } },
  { file: "nodetest_fail.txt", tool: "node --test", n: 2, check: (r) => {
      // real `node --test` (TAP) run of sindresorhus/p-queue with the default
      // concurrency changed. This output was not supported at all - it fell through
      // to the generic guess and printed "error: |-", a YAML block marker.
      assert.equal(r.summary, "11 failed, 195 passed");
      const f = r.failures[0];
      assert.equal(f.title, "isRateLimited property");
      assert.match(f.file, /advanced\.ts$/);
      // `error: |-` is a YAML block scalar; its content is the deeper-indented lines
      assert.match(f.message, /^AssertionError: Expected values to be strictly equal:/);
      assert.match(f.message, /false !== true/);
      assert.ok(!/\|-|duration_ms|failureType|code:/.test(f.message),
        "YAML plumbing must not survive into the message");
      assert.equal(r.failures[1].title, "rate-limit events fire only once per transition");
    } },
  { file: "gradle_script_fail.txt", tool: "gradle", n: 1, check: (r) => {
      // real `gradle test` on stleary/JSON-java under Gradle 9, which removed the
      // sourceCompatibility property. The build script fails to evaluate - a very
      // common failure - and whatbroke printed NOTHING at all: jvm.js detected the
      // output but extracted no failure, and the generic fallback does not match
      // "FAILURE:" (no word boundary after FAIL) or "with an exception." (no colon).
      const f = r.failures[0];
      assert.equal(f.title, "build script");
      assert.match(f.file, /build\.gradle$/);
      assert.equal(f.line, 55);
      assert.match(f.message, /A problem occurred evaluating root project/);
      // the "> " detail line carries the actual cause and must not be dropped
      assert.match(f.message, /Could not set unknown property 'sourceCompatibility'/);
      assert.ok(!/^>/m.test(f.message), "gradle's leading > is punctuation, not content");
    } },
  { file: "tsc_chain_fail.txt", tool: "tsc", n: 5, check: (r) => {
      // real tsc run of pillarjs/path-to-regexp after changing one type alias.
      // tsc explains an assignability failure as an indented chain, and the LAST
      // line is the actual reason. Only the head line was kept, which is the least
      // specific thing tsc said.
      assert.equal(r.summary, "5 errors in 2 files");
      const f = r.failures[0];
      assert.equal(f.title, "TS2322");
      assert.equal(f.line, 333);
      assert.match(f.message, /not assignable to type 'false \| Encode \| undefined'/);
      assert.match(f.message, /Type 'string' is not assignable to type 'number'\./,
        "the deepest line is the root cause and must survive");
      // the chain must not swallow the next error's head line
      assert.ok(!/error TS/.test(f.message), "a following diagnostic leaked into the chain");
      assert.equal(r.failures[1].line, 1237);
    } },
  { file: "eslint_bulk_fail.txt", tool: "eslint", n: 90, check: (r) => {
      // real eslint run over axios/lib. This is the case clustering exists for:
      // one rule broken in many places is one thing to fix, not twenty-two.
      assert.match(r.summary, /117 problems \(90 errors, 27 warnings\)/);
      const reported = r.clusters.filter((c) => c.reported);
      assert.ok(reported.length >= 3, `expected several causes, got ${reported.length}`);
      assert.ok(reported[0].size >= 20, `largest cause should be large, got ${reported[0].size}`);
      // warnings are counted and set aside, so failures are errors only
      assert.equal(r.failures.length, 90);
    } },
  { file: "mypy_notes_fail.txt", tool: "mypy", n: 41, check: (r) => {
      // real mypy run over psf/requests. mypy attaches its explanation as separate
      // "note:" lines at the SAME file and line - for a call-overload failure those
      // notes carry the valid signatures, which is the entire answer. They were
      // dropped, leaving "no overload variant matches" and nothing to act on.
      assert.equal(r.summary, "41 errors in 10 files");
      const overload = r.failures.find((f) => /No overload variant/.test(f.message));
      assert.ok(overload, "the overload error should be present");
      assert.match(overload.message, /Possible overload variants:/,
        "the note explaining the error must be attached to it");
      assert.match(overload.message, /def iter_content/);
      // notes are an explanation, not extra errors
      assert.equal(r.failures.length, 41, "notes must not inflate the failure count");
      assert.equal(r.failures.filter((f) => /^Possible overload/.test(f.message)).length, 0,
        "a note must never become a failure of its own");
    } },
  { file: "clang_bulk_fail.txt", tool: "clang", n: 14, check: (r) => {
      // real clang run over DaveGamble/cJSON after dropping an argument at every
      // call site of one function. One signature, fourteen callers - the clearest
      // case in the suite of many failures being a single thing to fix.
      const reported = r.clusters.filter((c) => c.reported);
      assert.equal(reported.length, 1, "fourteen callers of one function is one cause");
      assert.equal(reported[0].size, 14);
      assert.match(r.failures[0].message, /too few arguments to function call/);
      // clang's note points at the declaration, a DIFFERENT line, so unlike mypy's
      // same-location notes it is a separate remark and must not become a failure
      assert.equal(r.failures.length, 14, "notes must not be counted as errors");
      assert.ok(!r.failures.some((f) => /declared here/.test(f.message)));
    } },
  { file: "clippy_fail.txt", tool: "cargo", n: 15, check: (r) => {
      // real `cargo clippy -- -D warnings` on clap-rs/clap, the way CI runs it.
      // clippy diagnostics carry no E-code, so every one of them was untitled. The
      // lint name is the handle you actually want - it is what you search for and
      // what goes in an #[allow(...)].
      assert.equal(r.failures.filter((f) => !f.title).length, 0, "every clippy error must name its lint");
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
  { file: "rspec_profile_fail.txt", tool: "rspec", n: 1, check: (r) => {
      // real rspec run of piotrmurach/tty-color with the default colour mode changed.
      // Two bugs this caught: the summary was rebuilt from the numbers and so always
      // said "failures", where rspec itself writes "1 failure"; and rspec prints its
      // profiling block between the failures and "Finished in", so "Top 2 slowest
      // examples" was absorbed into the last failure's message.
      assert.equal(r.summary, "60 examples, 1 failure");
      const f = r.failures[0];
      assert.equal(f.file, "./spec/unit/mode_spec.rb");
      assert.equal(f.line, 16);
      assert.match(f.message, /expected: 8/);
      assert.match(f.message, /got: 16/);
      assert.ok(!/slowest|seconds average/.test(f.message),
        "profiling output must not land inside a failure");
    } },
  { file: "npm_fail.txt", tool: "npm", n: 1, check: (r) => {
      // real `npm run nonexistent-script`. Modern npm prefixes every line with
      // "npm error", which does not start with the word "error", so the generic
      // fallback never matched and a mistyped script name produced no output at all.
      const f = r.failures[0];
      assert.match(f.message, /Missing script: "nonexistent-script"/);
      // everything npm says after naming the problem is chatter
      assert.ok(!/complete log of this run|To see a list of scripts/.test(f.message),
        "npm's trailing advice is not the failure");
      assert.ok(!/^npm error/m.test(f.message), "the npm prefix is plumbing, not content");
    } },
  { file: "bun_fail.txt", tool: "bun test", n: 2, check: (r) => {
      // real `bun test` run of pillarjs/path-to-regexp. bun writes "error:" at the
      // start of a line, which is exactly what the cargo parser looks for, so bun
      // output was claimed by cargo and came back as two locationless errors.
      assert.equal(r.summary, "192 fail, 191 pass");
      const f = r.failures[0];
      assert.match(f.file, /index\.spec\.ts$/);
      assert.equal(f.line, 274);
      assert.match(f.title, /^path-to-regexp > /);
      assert.ok(!/\[[\d.]+ms\]/.test(f.title), "the timing is not part of the test name");
      assert.match(f.message, /expect\(received\)\.toEqual\(expected\)/);
      // bun echoes the source and a caret, and labels its diff with tallies
      assert.ok(!/^\s*\d+\s*\|/m.test(f.message), "echoed source is not the message");
      assert.ok(!/^[-+]\s*(Expected|Received)\s+[-+]\s*\d+$/m.test(f.message), "diff tallies kept");
    } },
  { file: "deno_fail.txt", tool: "deno test", n: 2, check: (r) => {
      // real `deno test` run. Unsupported before: it fell through to the generic
      // guess, which reported three "errors" - two real failures plus deno's own
      // "error: Test failed" tally, which is a verdict, not a failure.
      assert.equal(r.summary, "2 failed, 1 passed");
      const f = r.failures[0];
      assert.equal(f.title, "invoice total");
      assert.equal(f.file, "./math_test.ts");
      assert.equal(f.line, 4);
      assert.match(f.message, /AssertionError: Values are not equal/);
      assert.match(f.message, /1049/);
      assert.ok(!r.failures.some((g) => /Test failed/.test(g.message)),
        "deno's final verdict is not a failure of its own");
      // the frames are inside the assert library, not the user's code
      assert.ok(!/jsr\.io/.test(f.message));
    } },
];

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

// crafted output must not be able to make us read files outside the working dir
try {
  const { render, setColor } = await import("../src/render.js");
  const { resetSnippetCache } = await import("../src/snippet.js");
  const { writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  setColor(false);
  const outside = join(tmpdir(), "whatbroke-must-not-read.txt");
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

// pytest -q prints its summary with no === decoration; it must still be found
try {
  const q = [
    "FF..",
    "=================================== FAILURES ===================================",
    "______________________________ test_one ______________________________",
    "",
    "    def test_one():",
    ">       assert 1 == 2",
    "E       assert 1 == 2",
    "",
    "t.py:2: AssertionError",
    "=========================== short test summary info ============================",
    "FAILED t.py::test_one - assert 1 == 2",
    // -q ends with a bare totals line, no === decoration around it
    "85 failed, 1973 passed, 25 skipped, 31000 deselected, 1 xfailed in 3.58s",
  ].join("\n");
  const r = analyse(q);
  assert.ok(r, "quiet pytest output must still parse");
  assert.equal(r.tool, "pytest");
  assert.match(r.summary, /^85 failed, 1973 passed/,
    "the real totals must be reported, not a count of parsed blocks");
  console.log("  ok   pytest -q summary is found without the === decoration");
  pass++;
} catch (e) { console.log(`  FAIL pytest -q summary\n       ${e.message}`); fail++; }

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

// ---------------------------------------------------------------- clustering

// skeleton() is pinned exactly: these are the rules, and they must not drift.
try {
  const { skeleton } = await import("../src/cluster.js");
  const table = [
    [`assert 'Error: Missing argument' in "Usage:\ncli"`, "assert <str> in <str>"],
    ["KeyError: 'exp'", "KeyError: exp"],
    ["Cannot read properties of null (reading 'id')", "Cannot read properties of null (reading id)"],
    ["<click.testing.CliRunner object at 0x10c3f4d90>", "<click.testing.CliRunner object at <addr>>"],
    ["assert 1049 == 1050", "assert <num> == <num>"],
    ["expected `String`, found integer", "expected String, found integer"],
    ["test_shop.py:4: AssertionError", "<path>:<num>: AssertionError"],
    ["cart.total is not a function", "cart.total is not a function"],
    [`Argument 1 to "total" has incompatible type "str"`, "Argument <num> to total has incompatible type str"],
    ["doesn't exist on type 'User'", "doesn't exist on type User"],
    ["assert total([1000, 49], 0.5) == 1050", "assert total([<num>*], <num>) == <num>"],
    ["error[E0308] TS2551 i64 utf8", "error[E0308] TS2551 i64 utf8"],
  ];
  for (const [input, want] of table) {
    assert.equal(skeleton(input), want, `skeleton(${JSON.stringify(input)})`);
  }
  console.log(`  ok   skeleton normalises ${table.length} known shapes exactly`);
  pass++;
} catch (e) { console.log(`  FAIL skeleton table\n       ${e.message}`); fail++; }

// Every rule gets a pair: one that MUST join (fails if the rule is deleted) and one
// that MUST split (fails if the rule is widened). Pinned from both sides.
try {
  const { skeleton } = await import("../src/cluster.js");
  const same = (a, b) => skeleton(a) === skeleton(b);
  const join = [
    ["numbers", "assert cart.total() == 1050", "assert cart.total() == 1051"],
    ["quoted data", `assert 'Error: A' in out`, `assert 'Error: B B' in out`],
    ["quote style", `KeyError: 'exp'`, `KeyError: "exp"`],
    ["paths", "at tests/a/b.py line 1", "at src/c/d.py line 99"],
    ["addresses", "<X object at 0x1a2b>", "<X object at 0xffee>"],
    ["numeric runs", "call([1, 2, 3])", "call([7, 8, 9])"],
    // "/route.json" hits the extension rule and "/foo/bar" the separator rule; if the
    // extension rule leaves the leading slash behind they never cluster together
    ["path shape is consistent across sub-rules", "equal { path: '/route.json' }", "equal { path: '/foo/bar' }"],
  ];
  const split = [
    ["diagnostic codes survive <num>", "TS2551 not assignable", "TS2339 not assignable"],
    ["quoted identifiers kept", "KeyError: 'exp'", "KeyError: 'sub'"],
    ["type names kept", `type 'string' bad`, `type 'Buffer' bad`],
    ["attribute access is not a path", "cart.total is not a function", "user.save is not a function"],
    ["hex needs a digit", "defaced the value", "deadbee the value"],
    ["brackets in messages kept", "expected list[int]", "expected list[str]"],
    ["apostrophe lookbehind", "doesn't exist on type 'User'", "doesn't exist on type 'Post'"],
  ];
  for (const [why, a, b] of join) assert.ok(same(a, b), `must JOIN (${why}): ${skeleton(a)} vs ${skeleton(b)}`);
  for (const [why, a, b] of split) assert.ok(!same(a, b), `must SPLIT (${why}): both ${skeleton(a)}`);
  console.log(`  ok   ${join.length} must-join and ${split.length} must-split rules hold`);
  pass++;
} catch (e) { console.log(`  FAIL join/split pairs\n       ${e.message}`); fail++; }

// Clusters must partition the failures: nothing lost, nothing double counted.
try {
  let checked = 0;
  for (const file of readdirSync(join(here, "fixtures"))) {
    const r = analyse(fx(file));
    if (!r) continue;
    checked++;
    const members = r.clusters.flatMap((c) => c.members).sort((a, b) => a - b);
    assert.deepEqual(members, [...r.failures.keys()], `${file}: not a partition`);
    for (const c of r.clusters) {
      assert.equal(c.size, c.members.length, `${file}: size disagrees with members`);
      assert.ok(c.members.includes(c.exemplar), `${file}: exemplar outside its cluster`);
    }
    assert.equal(r.clusters.reduce((n, c) => n + c.size, 0), r.failures.length, `${file}: sizes do not sum`);
  }
  console.log(`  ok   clusters partition every failure across ${checked} fixtures`);
  pass++;
} catch (e) { console.log(`  FAIL cluster partition\n       ${e.message}`); fail++; }

// A normalisation rule that eats its own output looks fine until it silently
// changes results. Idempotence catches that class outright.
try {
  const { skeleton } = await import("../src/cluster.js");
  let n = 0;
  for (const file of readdirSync(join(here, "fixtures"))) {
    const r = analyse(fx(file));
    if (!r) continue;
    for (const f of r.failures) {
      for (const t of [f.message, f.stmt, f.title]) {
        const once = skeleton(t);
        assert.equal(skeleton(once), once, `${file}: skeleton not idempotent on ${JSON.stringify(String(t).slice(0, 60))}`);
        n++;
      }
    }
  }
  console.log(`  ok   skeleton is idempotent over ${n} real strings`);
  pass++;
} catch (e) { console.log(`  FAIL skeleton idempotence\n       ${e.message}`); fail++; }

// Clustering must not change what anyone already sees. Any fixture that legitimately
// grows a cluster belongs in this list, with a reason - so a merge can never appear
// silently in someone's terminal.
try {
  const { render, setColor } = await import("../src/render.js");
  setColor(false);
  // Fixtures that legitimately group. Anything not listed here must render
  // byte-identically with clustering on, so a merge can never appear silently.
  const EXPECTED_TO_CLUSTER = [
    "gotest_cluster_fail.txt",   // three tests share one assertion shape
    "eslint_bulk_fail.txt",      // one rule broken in twenty-two places
    "mypy_notes_fail.txt",       // several type errors repeat across modules
    "clang_bulk_fail.txt",       // one signature change, fourteen call sites
    "clippy_fail.txt",           // one lint in several places is one fix
  ];
  let checked = 0;
  for (const file of readdirSync(join(here, "fixtures"))) {
    const raw = fx(file);
    const on = analyse(raw), off = analyse(raw, { cluster: false });
    if (!on) continue;
    checked++;
    const differs = render(on, {}) !== render(off, { cluster: false });
    if (EXPECTED_TO_CLUSTER.includes(file)) assert.ok(differs, `${file}: expected to cluster but did not`);
    else assert.ok(!differs, `${file}: clustering changed existing output`);
  }
  console.log(`  ok   clustering changes ${EXPECTED_TO_CLUSTER.length} of ${checked} fixture renders, the ${EXPECTED_TO_CLUSTER.length === 1 ? "one" : "ones"} expected to`);
  pass++;
} catch (e) { console.log(`  FAIL byte identity\n       ${e.message}`); fail++; }

// A new extractor must not silently inherit a title policy. Adding one forces a choice.
try {
  const { TOOL_TITLE_SETS } = await import("../src/cluster.js");
  const { TITLE_IS_CODE, TITLE_IS_SITE, TITLE_IS_CONST } = TOOL_TITLE_SETS;
  const tools = new Set();
  for (const file of readdirSync(join(here, "fixtures"))) {
    const r = analyse(fx(file));
    if (r) tools.add(r.tool);
  }
  for (const t of tools) {
    const hits = [TITLE_IS_CODE, TITLE_IS_SITE, TITLE_IS_CONST].filter((s) => s.has(t)).length;
    assert.equal(hits, 1, `tool ${JSON.stringify(t)} is in ${hits} title sets, must be exactly 1`);
  }
  console.log(`  ok   all ${tools.size} tools declare a title policy exactly once`);
  pass++;
} catch (e) { console.log(`  FAIL title policy coverage\n       ${e.message}`); fail++; }

// The guards against over-merging, which is the fatal direction.
try {
  const { clusterFailures, MIN_CLUSTER } = await import("../src/cluster.js");
  // 40 numeric assertions from 40 unrelated bugs must never become "1 likely cause"
  const bare = Array.from({ length: 40 }, (_, i) => ({ title: `t${i}`, message: `assert ${i} == ${i + 1}` }));
  assert.ok(clusterFailures(bare, "pytest").every((c) => !c.reported),
    "a bare numeric assertion carries no information and must not be a reported cause");

  // three failures that really do share a cause
  const real = Array.from({ length: 3 }, (_, i) => ({ title: `t${i}`, file: `a${i}.py`, line: i + 1, message: "KeyError: 'exp'" }));
  const got = clusterFailures(real, "pytest").filter((c) => c.reported);
  assert.equal(got.length, 1, "three matching failures should be one reported cause");
  assert.equal(got[0].size, 3);

  // two is coincidence, not a cause
  assert.equal(MIN_CLUSTER, 3);
  assert.ok(clusterFailures(real.slice(0, 2), "pytest").every((c) => !c.reported), "two must not be reported");
  console.log("  ok   the information gate and minimum size both refuse weak merges");
  pass++;
} catch (e) { console.log(`  FAIL merge guards\n       ${e.message}`); fail++; }

// Rendering a real cluster: header, one exemplar, distinct sites only.
try {
  const { render, setColor } = await import("../src/render.js");
  const { clusterFailures } = await import("../src/cluster.js");
  setColor(false);
  const failures = [
    { title: "test_a", file: "t/one.py", line: 10, message: "KeyError: 'exp'" },
    { title: "test_b", file: "t/two.py", line: 20, message: "KeyError: 'exp'" },
    { title: "test_c", file: "t/two.py", line: 20, message: "KeyError: 'exp'" },
    { title: "test_d", file: "t/three.py", line: 30, message: "KeyError: 'exp'" },
  ];
  const out = render({ tool: "pytest", failures, clusters: clusterFailures(failures, "pytest") }, { source: false });
  assert.match(out, /1 likely cause, 4 sites/, "header must state the cause count");
  assert.equal((out.match(/KeyError/g) || []).length, 1, "the exemplar message prints once, not once per member");
  assert.match(out, /also t\/two\.py:20, t\/three\.py:30/, "sibling sites are named");
  assert.equal((out.match(/t\/two\.py:20/g) || []).length, 1, "a repeated location is named once, not per member");
  console.log("  ok   a cluster renders one exemplar and its distinct sites");
  pass++;
} catch (e) { console.log(`  FAIL cluster rendering\n       ${e.message}`); fail++; }

// Hostile input must still yield a valid partition, not merely avoid throwing.
try {
  const hostile = ["", "\0\0", "[31m", "!!!".repeat(1000), "a".repeat(50000),
    "assert 'unterminated in x", "{}", "::::", "\n\n\n", "error: " + "x".repeat(5000)];
  for (const h of hostile) {
    const r = analyse(h);
    if (!r) continue;
    const members = r.clusters.flatMap((c) => c.members).sort((a, b) => a - b);
    assert.deepEqual(members, [...r.failures.keys()], `hostile input broke the partition: ${JSON.stringify(h.slice(0, 20))}`);
  }
  console.log("  ok   hostile input still produces a valid partition");
  pass++;
} catch (e) { console.log(`  FAIL hostile partition\n       ${e.message}`); fail++; }

// --no-cluster must mean no clustering everywhere, not "clustered but hidden".
try {
  const off = spawnSync(process.execPath, [cli, "--format", "json", "--no-cluster", "--", process.execPath, "-e", "null.x"], { encoding: "utf8" });
  assert.equal(JSON.parse(off.stdout).clusters, null, "--no-cluster must null the clusters field in JSON too");
  const on = spawnSync(process.execPath, [cli, "--format", "json", "--", process.execPath, "-e", "null.x"], { encoding: "utf8" });
  assert.ok(Array.isArray(JSON.parse(on.stdout).clusters), "clustering is on by default");
  console.log("  ok   --no-cluster disables clustering in every format");
  pass++;
} catch (e) { console.log(`  FAIL --no-cluster flag\n       ${e.message}`); fail++; }

// no rendered line may run away, however long the paths in a cluster's site list
try {
  const { render, setColor } = await import("../src/render.js");
  setColor(false);
  const long = (n) => `packages/some-workspace/src/adapters/very/deep/module-${n}.js`;
  const failures = Array.from({ length: 12 }, (_, i) => ({
    file: long(i), line: 100 + i, title: "eqeqeq", message: "Expected '===' and instead saw '=='",
  }));
  const { clusterFailures } = await import("../src/cluster.js");
  const out = render({ tool: "eslint", failures, clusters: clusterFailures(failures, "eslint") }, { source: false });
  const longest = Math.max(...out.split("\n").map((l) => l.length));
  assert.ok(longest <= 240, `a site list ran to ${longest} characters`);
  assert.match(out, /more places/, "the sites that did not fit are counted");
  console.log("  ok   a cluster's site list stays within a line");
  pass++;
} catch (e) { console.log(`  FAIL site list width\n       ${e.message}`); fail++; }

// a CI log stamps every line, and every parser anchors on ^
try {
  const { stripCiPrefix } = await import("../src/util.js");
  const raw = fx("pytest_fail.txt");
  const lines = raw.split("\n");
  const plain = analyse(raw);

  // GitHub Actions raw log: an ISO timestamp on every line
  const stamped = lines.map((l) => `2026-09-09T04:47:46.0890607Z ${l}`).join("\n");
  const a = analyse(stamped);
  assert.ok(a, "a timestamped CI log must still parse");
  assert.equal(a.failures.length, plain.failures.length);
  assert.deepEqual(a.failures.map((f) => f.line), plain.failures.map((f) => f.line));

  // `gh run view --log`: tab-separated job and step names before the timestamp
  const withJob = lines.map((l) => `test (ubuntu-latest, 22)\tRun pytest\t2026-09-09T04:47:46.089Z ${l}`).join("\n");
  assert.equal(analyse(withJob)?.failures.length, plain.failures.length,
    "job and step columns must be stripped along with the timestamp");

  // but a log that merely MENTIONS a timestamp must be left exactly alone
  const occasional = lines.map((l, i) => (i % 9 === 0 ? `2026-09-09T04:47:46.000Z ${l}` : l)).join("\n");
  assert.equal(stripCiPrefix(occasional), occasional, "a partial match must not be stripped");
  assert.equal(stripCiPrefix(raw), raw, "output with no prefix must be untouched");
  console.log("  ok   CI-stamped logs parse, and unstamped logs are untouched");
  pass++;
} catch (e) { console.log(`  FAIL CI log prefix\n       ${e.message}`); fail++; }

// a CI log runs lint, then typecheck, then tests - only one extractor can own the
// output, and the rest of the failures must not vanish without a word
try {
  const combined = ["> lint", fx("eslint_bulk_fail.txt"), "", "> typecheck",
    fx("tsc_chain_fail.txt"), "", "> test", fx("vitest_cluster_fail.txt")].join("\n");
  const r = analyse(combined);
  assert.ok(r, "a multi-tool log must still parse");
  assert.ok(r.others?.length, "the other tools' failures must be named, not dropped");
  const named = Object.fromEntries(r.others.map((o) => [o.tool, o.count]));
  assert.equal(named.eslint, 90, `eslint's 90 errors must be accounted for: ${JSON.stringify(named)}`);
  assert.equal(named.tsc, 5);

  // but a tool that reports the same failure a second way is not another tool:
  // unittest prints its failures AS Python tracebacks
  const single = analyse(fx("py_unittest.txt"));
  assert.ok(!single.others, `unittest should not report python as a separate tool: ${JSON.stringify(single.others)}`);
  console.log("  ok   other tools in the same log are named, overlapping ones are not");
  pass++;
} catch (e) { console.log(`  FAIL multi-tool log\n       ${e.message}`); fail++; }

// When two parsers both claim a fixture, only their order in the list decides the
// answer - which is how bun test came back as cargo errors. Pin the known cases so
// a new parser cannot quietly introduce another.
try {
  const { EXTRACTORS } = await import("../src/index.js");
  const { stripAnsi, stripCiPrefix } = await import("../src/util.js");
  const KNOWN = {
    // unittest reports its failures AS Python tracebacks, so both match by design
    // and the more specific one is listed first
    "py_unittest.txt": ["unittest", "python"],
  };
  const found = {};
  for (const file of readdirSync(join(here, "fixtures"))) {
    const s = stripCiPrefix(stripAnsi(fx(file)).replace(/\r\n?/g, "\n"));
    const claimers = EXTRACTORS
      .filter((e) => e.name !== "generic" && e.detect(s) && e.extract(s)?.failures?.length)
      .map((e) => e.name);
    if (claimers.length > 1) found[file] = claimers;
  }
  assert.deepEqual(found, KNOWN,
    `parsers competing for a fixture changed: ${JSON.stringify(found)}`);
  console.log("  ok   only one fixture is decided by parser order, and it is expected");
  pass++;
} catch (e) { console.log(`  FAIL parser overlap\n       ${e.message}`); fail++; }

// on Windows these tools emit backslash separators; parsing must not depend on /
try {
  const cases = {
    "tsc_chain_fail.txt": (t) => t.replace(/src\//g, "src\\"),
    "eslint_bulk_fail.txt": (t) => t.replace(/lib\//g, "lib\\").replace(/adapters\//g, "adapters\\"),
    "dotnet_fail.txt": (t) => t.replace(/\//g, "\\"),
  };
  for (const [file, toWindows] of Object.entries(cases)) {
    const unix = analyse(fx(file));
    const win = analyse(toWindows(fx(file)));
    assert.ok(win, `${file}: windows paths stopped it parsing`);
    assert.equal(win.tool, unix.tool, `${file}: windows paths changed the tool`);
    assert.equal(win.failures.length, unix.failures.length, `${file}: windows paths changed the count`);
    assert.deepEqual(win.failures.map((f) => f.line), unix.failures.map((f) => f.line));
    assert.match(win.failures[0].file, /\\/, `${file}: the backslash path should be preserved`);
  }
  console.log("  ok   windows backslash paths parse the same as posix ones");
  pass++;
} catch (e) { console.log(`  FAIL windows paths\n       ${e.message}`); fail++; }

// CRLF input must parse identically to LF - Windows, and logs pasted from Windows CI
try {
  for (const name of ["pytest_fail.txt", "gotest_fail.txt", "cargobuild_fail.txt", "node_stack.txt"]) {
    const lf = analyse(fx(name));
    const crlf = analyse(fx(name).replace(/\n/g, "\r\n"));
    assert.ok(crlf, `${name}: nothing extracted from CRLF input`);
    assert.equal(crlf.tool, lf.tool, `${name}: CRLF changed the detected tool`);
    assert.equal(crlf.failures.length, lf.failures.length, `${name}: CRLF changed the failure count`);
    assert.deepEqual(crlf.failures.map((f) => f.line), lf.failures.map((f) => f.line),
      `${name}: CRLF changed the line numbers`);
    assert.ok(!JSON.stringify(crlf).includes("\\r"), `${name}: a carriage return survived into the output`);
  }
  console.log("  ok   CRLF input parses identically to LF");
  pass++;
} catch (e) { console.log(`  FAIL CRLF input\n       ${e.message}`); fail++; }

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

// a clean run must not be mistaken for a failure
const CLEAN = "============ test session starts ============\ncollected 2 items\n\ntest_a.py ..    [100%]\n\n============ 2 passed in 0.01s ============\n";
try {
  const r = analyse(CLEAN);
  assert.ok(!r || r.failures.length === 0, "clean pytest run must yield no failures");
  console.log("  ok   clean run yields nothing");
  pass++;
} catch (e) { console.log(`  FAIL clean run\n       ${e.message}`); fail++; }

// JSON is a stable automation interface, including the wrapped command's exit code.
try {
  const r = spawnSync(process.execPath, [cli, "--json", "node", "-e",
    "try { null.x } catch (e) { console.error(e.stack); process.exit(3) }"], { encoding: "utf8" });
  assert.equal(r.status, 3);
  const json = JSON.parse(r.stdout);
  assert.equal(json.version, 1);
  assert.equal(json.tool, "node");
  assert.equal(json.exitCode, 3);
  assert.equal(json.truncated, false);
  assert.ok(Array.isArray(json.failures));
  assert.equal(r.stderr.includes("TypeError"), true);
  assert.equal(r.stdout.startsWith("{"), true);
  console.log("  ok   JSON output has a stable envelope and preserves exit code");
  pass++;
} catch (e) { console.log(`  FAIL JSON output\n       ${e.message}`); fail++; }

try {
  const r = spawnSync(process.execPath, [cli, "--format", "json", "--max-bytes", "1024",
    "node", "-e", "console.error('x'.repeat(5000)); process.exit(1)"], { encoding: "utf8" });
  assert.equal(r.status, 1);
  const json = JSON.parse(r.stdout);
  assert.equal(json.truncated, true);
  console.log("  ok   large output is bounded and reports truncation");
  pass++;
} catch (e) { console.log(`  FAIL bounded output\n       ${e.message}`); fail++; }

try {
  const r = spawnSync(process.execPath, [cli, "--quiet", "--max-bytes", "1024",
    "node", "-e", "console.error('x'.repeat(5000)); process.exit(1)"], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /output capture limit reached/);
  console.log("  ok   terminal output reports truncation");
  pass++;
} catch (e) { console.log(`  FAIL terminal truncation\n       ${e.message}`); fail++; }

try {
  const r = spawnSync(process.execPath, [cli, "--github-actions", "node", "-e",
    "try { null.x } catch (e) { console.error(e.stack); process.exit(1) }"], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /::error file=\[eval\],line=1,col=12,title=TypeError::/);
  console.log("  ok   GitHub Actions output contains clickable annotations");
  pass++;
} catch (e) { console.log(`  FAIL GitHub Actions output\n       ${e.message}`); fail++; }

try {
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "whatbroke-summary-"));
  const summary = join(dir, "summary.md");
  const r = spawnSync(process.execPath, [cli, "--github-actions", "node", "-e",
    "null.x"], { encoding: "utf8", env: { ...process.env, GITHUB_STEP_SUMMARY: summary } });
  assert.equal(r.status, 1);
  assert.match(readFileSync(summary, "utf8"), /## whatbroke/);
  assert.ok(!/[^\n]\\\*/.test(readFileSync(summary, "utf8")), "summary should remain valid markdown");
  rmSync(dir, { recursive: true, force: true });
  console.log("  ok   GitHub Actions summary is written");
  pass++;
} catch (e) { console.log(`  FAIL GitHub Actions summary\n       ${e.message}`); fail++; }

try {
  const r = spawnSync(process.execPath, [cli, "--quiet", "--max-bytes", "1024",
    "node", "-e", "console.error('x'.repeat(5000)); process.exit(1)"], { encoding: "utf8" });
  assert.ok(!/\x1b\[33m/.test(r.stdout), "non-TTY output must not contain ANSI color codes");
  console.log("  ok   non-TTY truncation warning stays plain text");
  pass++;
} catch (e) { console.log(`  FAIL non-TTY truncation\n       ${e.message}`); fail++; }

try {
  const r = spawnSync(process.execPath, [cli, "--format=json", "node", "-e",
    "console.log('must not corrupt stdout'); process.exit(4)"], { encoding: "utf8" });
  assert.equal(r.status, 4);
  const json = JSON.parse(r.stdout);
  assert.equal(json.version, 1);
  assert.equal(json.exitCode, 4);
  console.log("  ok   explicit format selector keeps JSON valid");
  pass++;
} catch (e) { console.log(`  FAIL format selector\n       ${e.message}`); fail++; }

try {
  const r = spawnSync(process.execPath, [cli, "--format", "invalid"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown format/);
  console.log("  ok   invalid format is rejected clearly");
  pass++;
} catch (e) { console.log(`  FAIL invalid format\n       ${e.message}`); fail++; }

try {
  const duplicate = "fatal: broken\nfatal: broken\n";
  const { analyse } = await import("../src/index.js");
  const r = analyse(duplicate);
  assert.equal(r.failures.length, 1);
  assert.equal(r.guessed, true);
  console.log("  ok   duplicate diagnostics are collapsed");
  pass++;
} catch (e) { console.log(`  FAIL duplicate diagnostics\n       ${e.message}`); fail++; }

try {
  const r = spawnSync(process.execPath, [cli, "--no-source", "node", "-e",
    "null.x"], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /Cannot read properties of null/);
  assert.match(r.stdout, /\[eval\]:1/);
  assert.ok(!/│ null\.x/.test(r.stdout), "source context must be disabled");
  console.log("  ok   no-source mode avoids reading source context");
  pass++;
} catch (e) { console.log(`  FAIL no-source mode\n       ${e.message}`); fail++; }

try {
  const r = spawnSync(process.execPath, [cli, "--format"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--format requires/);
  console.log("  ok   missing format value is rejected clearly");
  pass++;
} catch (e) { console.log(`  FAIL missing format\n       ${e.message}`); fail++; }

try {
  const r = spawnSync(process.execPath, [cli, "--format", "json", "whatbroke-command-does-not-exist"], { encoding: "utf8" });
  assert.equal(r.status, 127);
  assert.match(r.stderr, /whatbroke-command-does-not-exist/);
  const json = JSON.parse(r.stdout);
  assert.equal(json.exitCode, 127);
  assert.match(json.error, /whatbroke-command-does-not-exist/);
  console.log("  ok   command-not-found preserves a distinct 127 failure");
  pass++;
} catch (e) { console.log(`  FAIL command-not-found\n       ${e.message}`); fail++; }

try {
  const r = spawnSync(process.execPath, [cli, "--format", "json", "node", "-e", "process.kill(process.pid, 'SIGTERM')"], { encoding: "utf8" });
  // Windows does not expose POSIX signal termination through child_process;
  // the same command exits with its native status code instead.
  const expectedStatus = process.platform === "win32" ? 1 : 143;
  assert.equal(r.status, expectedStatus);
  const json = JSON.parse(r.stdout);
  assert.equal(json.exitCode, expectedStatus);
  console.log("  ok   signal termination is represented as a shell-compatible exit code");
  pass++;
} catch (e) { console.log(`  FAIL signal termination\n       ${e.message}`); fail++; }

try {
  const { analyse } = await import("../src/index.js");
  const malformed = [
    "", "\0\0", "\u001b[31m", "error:", "Found NaN errors", "file:not-a-line",
    "1) incomplete", "e: :::: ", "[ERROR] [1,2]", "!!!".repeat(1000),
  ];
  for (const input of malformed) assert.doesNotThrow(() => analyse(input));
  console.log("  ok   malformed and hostile logs never throw");
  pass++;
} catch (e) { console.log(`  FAIL malformed logs\n       ${e.message}`); fail++; }

try {
  const { analyse } = await import("../src/index.js");
  const r = analyse("main.cpp:7:12: error: use of undeclared identifier 'total'\n");
  assert.equal(r.tool, "clang");
  assert.equal(r.failures[0].col, 12);
  console.log("  ok   compiler diagnostics do not cross-detect as mypy");
  pass++;
} catch (e) { console.log(`  FAIL compiler/mypy collision\n       ${e.message}`); fail++; }

try {
  const r = spawnSync(process.execPath, [cli, "--version"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+$/);
  console.log("  ok   version flag reports the package version");
  pass++;
} catch (e) { console.log(`  FAIL version flag\n       ${e.message}`); fail++; }

// every fixture must be covered
const files = readdirSync(join(here, "fixtures"));
const uncovered = files.filter((f) => !CASES.some((c) => c.file === f));
if (uncovered.length) console.log(`  note: uncovered fixtures: ${uncovered.join(", ")}`);

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
