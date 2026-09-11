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
  // Captured with Terraform 1.16. Terraform draws each diagnostic in a box, and the
  // vertical bar down the left is part of the drawing rather than the message.
  { file: "terraform_validate_fail.txt", tool: "terraform", n: 1, check: (r) => {
      assert.equal(r.failures[0].file, "main.tf");
      assert.equal(r.failures[0].line, 1);
      assert.equal(r.failures[0].title, "Missing required argument");
      assert.match(r.failures[0].subject, /resource "local_file" "demo"/);
      // the sentence at the bottom of the box is the one that says what to do
      assert.match(r.failures[0].message, /The argument "filename" is required/);
      // the box is not part of anything
      assert.doesNotMatch(JSON.stringify(r.failures), /[│╷╵]/);
      // and the headline is not repeated inside its own message
      assert.doesNotMatch(r.failures[0].message, /^Missing required argument$/m);
    } },
  // Captured with CMake 4.4 and ninja 1.13. ninja gets no parser on purpose: what fails
  // under it is a compiler, which already has one, and its own "FAILED: [code=1]" line
  // restates the failure without adding to it - exactly as make's exit line does. make
  // has a parser only for the failures make itself raises; see make_separator_fail.
  { file: "cmake_configure_fail.txt", tool: "cmake", n: 2, check: (r) => {
      assert.equal(r.failures[0].file, "CMakeLists.txt");
      assert.equal(r.failures[0].line, 3);
      assert.equal(r.failures[0].code, "add_executable", "the command that raised it is the closest thing to a code");
      assert.match(r.failures[0].message, /Cannot find source file/);
      assert.match(r.failures[0].message, /missing_source\.c/);
    } },
  { file: "cmake_syntax_fail.txt", tool: "cmake", n: 1, check: (r) => {
      // A parse error in the script names no command at all.
      assert.equal(r.failures[0].line, 2);
      assert.equal(r.failures[0].code, undefined);
      assert.match(r.failures[0].message, /Parse error\.\s+Function missing ending/);
    } },
  { file: "ninja_compile_fail.txt", tool: "clang", n: 2, check: (r) => {
      assert.match(r.failures[0].file, /main\.c$/);
      assert.doesNotMatch(JSON.stringify(r.failures), /FAILED: \[code=1\]|ninja: Entering/,
        "ninja's own lines restate the failure without adding to it");
    } },
  // Captured with kubectl 1.37 against no cluster.
  { file: "kubectl_yaml_fail.txt", tool: "kubectl", n: 1, check: (r) => {
      // The location is inside the message, which is the only place it appears.
      assert.equal(r.failures[0].file, "bad.yaml");
      assert.equal(r.failures[0].line, 9);
    } },
  { file: "kubectl_noserver_fail.txt", tool: "kubectl", n: 1, check: (r) => {
      // Five identical klog lines from inside client-go, then the sentence a person
      // wants. Reading it naively gives five failures; reading nothing gives none.
      assert.match(r.failures[0].message, /The connection to the server localhost:8080 was refused/);
      assert.doesNotMatch(JSON.stringify(r.failures), /memcache\.go|Couldn't get current server/);
      assert.doesNotMatch(r.failures[0].message, /did you specify the right host/,
        "how to fix it is not what went wrong");
    } },
  // Captured with @playwright/test. Playwright heads a failure with the location of the
  // TEST and then gives the location of the THROW further down, and closes each block
  // with a path to an artifact to go and read.
  { file: "playwright_fail.txt", tool: "playwright", n: 2, check: (r) => {
      assert.equal(r.summary, "2 failed");
      assert.deepEqual(r.failures.map((f) => f.title), ["adds up", "throws"]);
      // the throw's line, not the test's declaration line
      assert.equal(r.failures[0].line, 3);
      assert.equal(r.failures[1].line, 7);
      assert.match(r.failures[0].stmt, /expect\(1049\)\.toBe\(1050\)/);
      assert.match(r.failures[1].message, /Cannot read properties of null/);
      // "Error Context: test-results/..." is a file to open, not a failure - the guess
      // counted both of them as errors and missed the second real one
      assert.doesNotMatch(JSON.stringify(r.failures), /Error Context|error-context\.md/);
      // and the run's tally is not part of the last failure's message
      assert.doesNotMatch(r.failures[1].message, /2 failed/);
    } },
  // Captured with pyright 1.x. It puts the column after the line with a dash between
  // location and severity, and names the rule in brackets - sometimes at the end of an
  // indented explanation, sometimes at the end of the message itself.
  { file: "pyright_fail.txt", tool: "pyright", n: 3, check: (r) => {
      assert.equal(r.summary, "3 errors");
      assert.deepEqual(r.failures.map((f) => f.code),
        ["reportReturnType", "reportArgumentType", "reportUndefinedVariable"]);
      assert.equal(r.failures[0].line, 2);
      assert.equal(r.failures[0].col, 12, "the column is not the start of the message");
      assert.match(r.failures[0].message, /Type "int" is not assignable to return type "str"/);
      // the indented line under it says why, and was being dropped
      assert.match(r.failures[0].message, /"int" is not assignable to "str"/);
      // the rule name belongs in the code, not trailing the message
      assert.doesNotMatch(JSON.stringify(r.failures), /\(report[A-Za-z]+\)/);
    } },
  // Build tools fail in ways that have nothing to do with a compiler, and none of these
  // carries a file position for a diagnostic pattern to find.
  { file: "dotnet_noproject_fail.txt", tool: "dotnet", n: 1, check: (r) => {
      assert.equal(r.failures[0].code, "MSB1003");
      assert.equal(r.failures[0].file, undefined, "MSBUILD is the tool speaking, not a file");
      assert.match(r.failures[0].message, /Specify a project or solution file/);
    } },
  { file: "dotnet_restore_fail.txt", tool: "dotnet", n: 1, check: (r) => {
      // NuGet prints the same failure once as it happens and again under "Build FAILED."
      assert.equal(r.failures[0].code, "NU1101");
      assert.match(r.failures[0].file, /app\.csproj$/);
      assert.match(r.failures[0].message, /Unable to find package This\.Package\.Does\.Not\.Exist\.Xyz/);
    } },
  { file: "maven_dependency_fail.txt", tool: "maven", n: 1, check: (r) => {
      // Maven reports everything that is not a compiler diagnostic as a failed goal.
      assert.equal(r.failures[0].label, "goal failed");
      assert.match(r.failures[0].message, /Could not resolve dependencies/);
      assert.match(r.failures[0].message, /does-not-exist-xyz/);
      assert.doesNotMatch(r.failures[0].message, /\[Help 1\]|Re-run Maven/,
        "how to get more output is not what went wrong");
    } },
  { file: "gradle_dependency_fail.txt", tool: "gradle", n: 1, check: (r) => {
      // Already handled by the build-script branch; here so it stays that way.
      assert.match(r.failures[0].message, /Could not resolve com\.example\.nope/);
    } },
  { file: "rspec_load_fail.txt", tool: "rspec", n: 1, check: (r) => {
      // A spec file that raises while loading never becomes a numbered example, so it
      // is reported as prose above the tally instead.
      assert.equal(r.failures[0].file, "./spec/crash_spec.rb");
      assert.equal(r.failures[0].line, 1);
      assert.match(r.failures[0].message, /spec file blew up at load/);
      // and "0 examples, 0 failures" alone reads like success
      assert.match(r.summary, /1 error occurred outside of examples/);
    } },
  { file: "phpunit_error_fail.txt", tool: "phpunit", n: 1, check: (r) => {
      // PHPUnit heads an escaped exception "There was 1 error", not "1 failure", and
      // reading only the failure wording meant this fell through to the guess.
      assert.equal(r.summary, "1 error");
      assert.equal(r.failures[0].title, "ErrTest::testBoom");
      assert.equal(r.failures[0].line, 4);
      assert.match(r.failures[0].message, /Call to a member function method\(\) on null/);
      assert.doesNotMatch(r.failures[0].message, /ERRORS!/, "the banner is not part of the message");
    } },
  { file: "phpunit_load_fail.txt", tool: "phpunit", n: 1, check: (r) => {
      assert.equal(r.summary, "error inside PHPUnit");
      assert.match(r.failures[0].file, /CrashTest\.php$/);
      assert.equal(r.failures[0].line, 2);
      assert.match(r.failures[0].message, /test file blew up at load/);
      assert.doesNotMatch(JSON.stringify(r.failures), /phar:\/\//, "PHPUnit's own frames are not the cause");
    } },
  { file: "vitest_suite_fail.txt", tool: "vitest", n: 1, check: (r) => {
      // A suite that throws before declaring a test cannot be named after one, so vitest
      // lists it under "Failed Suites" with the file in brackets rather than a test name
      // after a chevron - and only the chevron form was being read.
      assert.equal(r.failures[0].file, "t/crash.test.js");
      assert.equal(r.failures[0].line, 1);
      assert.match(r.failures[0].message, /vitest suite failed to collect/);
      // "Tests: no tests" over a real failure reads as though nothing was wrong
      assert.match(r.summary, /1 failed \(1\) \(no tests ran\)/);
    } },
  { file: "nodetest_crash_fail.txt", tool: "node --test", n: 1, check: (r) => {
      // TAP faithfully reports error: 'test failed', which says nothing. What happened
      // was printed above as TAP comments, and that is the only place it appears.
      assert.match(r.failures[0].message, /node:test suite crashed at import/);
      assert.doesNotMatch(r.failures[0].message, /^test failed$/);
      assert.equal(r.failures[0].file, "/home/dev/app/nt_crash.test.js");
    } },
  // Four runtimes crashing outside any test. None has a parser and none needs one -
  // they are here to hold the fallback to a standard, because a message with no
  // location is half an answer and the location is right there in the log.
  // Bun stamps its own version at the foot of a crash, which nothing else writes. Before
  // that was used, the node parser claimed this - the frames are node-shaped enough - and
  // a `bun` command was reported as having failed under node.
  { file: "bunrun_crash_fail.txt", tool: "bun", n: 1, check: (r) => {
      assert.equal(r.failures[0].file, "/home/dev/app/crash.ts");
      assert.equal(r.failures[0].line, 1);
      assert.equal(r.failures[0].col, 36);
      assert.match(r.failures[0].message, /bun runtime crash/);
      // the echoed source above the error is numbered; the line the failure is on
      assert.match(r.failures[0].stmt, /^function boom\(\): never/);
      assert.deepEqual(r.failures[0].trace, [
        "boom (/home/dev/app/crash.ts:1:36)", "<anonymous> (/home/dev/app/crash.ts:2:1)",
      ]);
      // "error:" is a constant bun prints for a class of failure, not a diagnostic code
      assert.equal(r.failures[0].label, "error");
      assert.equal(r.failures[0].code, undefined);
    } },
  { file: "bun_syntax_fail.txt", tool: "bun", n: 1, check: (r) => {
      assert.match(r.failures[0].message, /^Expected identifier but found end of file$/);
      assert.equal(r.failures[0].line, 1);
      assert.equal(r.failures[0].stmt, "const x = {");
    } },
  { file: "bun_import_fail.txt", tool: "bun", n: 1, check: (r) => {
      // An unresolved import names no line at all - the path is inside the message.
      assert.equal(r.failures[0].file, undefined);
      assert.match(r.failures[0].message, /Cannot find module '\.\/nothing-here'/);
    } },
  // deno writes the word in lower case and puts its frames on file:// URLs, where node
  // writes the class capitalised at column zero - so the two do not collide. This was a
  // guess: it found the file and the line but kept "error: " inside the message.
  { file: "denorun_crash_fail.txt", tool: "deno", n: 1, check: (r) => {
      // deno prints the source line and a caret between the message and the frames.
      assert.equal(r.failures[0].file, "/home/dev/app/dcrash.ts");
      assert.equal(r.failures[0].line, 1);
    } },
  // PHP writes the fatal twice, to the error log and to stdout, differing by a "PHP "
  // prefix and a space. Counting both says the run failed twice as badly - the two copies
  // produce identical failures, so the pipeline's own de-duplication collapses them.
  { file: "php_fatal_fail.txt", tool: "php", n: 1, check: (r) => {
      assert.equal(r.failures[0].file, "/home/dev/app/bad.php");
      assert.equal(r.failures[0].line, 2);
      assert.match(r.failures[0].message, /Call to a member function method\(\) on null/);
      // the class is the searchable handle, and it is not left in the message as well
      assert.equal(r.failures[0].code, "Error");
      assert.doesNotMatch(r.failures[0].message, /Fatal error|Uncaught/);
      // "#1 {main}" is the entry point and carries nothing
      assert.deepEqual(r.failures[0].trace, ["f() (/home/dev/app/bad.php:3)"]);
      // the warning PHP printed first is context, not the headline - and it arrives
      // doubled too, so counting lines said two
      assert.equal(r.summary, "1 error, 1 warning first");
    } },
  // Captured on Deno 2.x.
  { file: "deno_syntax_fail.txt", tool: "deno", n: 1, check: (r) => {
      assert.equal(r.failures[0].code, "SyntaxError");
      assert.equal(r.failures[0].line, 1);
      assert.doesNotMatch(r.failures[0].message, /^error: /, "the word is not part of the message");
    } },
  { file: "deno_import_fail.txt", tool: "deno", n: 1, check: (r) => {
      // The module it could not resolve is named as a URL inside the message; the reader
      // wants the path, and the location is the line that asked for it.
      assert.equal(r.failures[0].line, 1);
      assert.doesNotMatch(r.failures[0].message, /file:\/\//, "the URL scheme is not part of the path");
      assert.match(r.failures[0].message, /Module not found ".*nothing-here\.ts"/);
    } },
  { file: "deno_check_fail.txt", tool: "deno check", n: 1, check: (r) => {
      // `deno check` ends with "error: Type checking failed." - a tally, not a diagnosis.
      // Reading that instead of the TS line above it lost the whole thing: the code, the
      // explanation and the location were all there and none of them was reported.
      assert.equal(r.failures[0].code, "TS2322");
      assert.equal(r.failures[0].line, 1);
      assert.equal(r.failures[0].col, 7);
      assert.match(r.failures[0].message, /^Type 'string' is not assignable to type 'number'\.$/);
      assert.doesNotMatch(JSON.stringify(r.failures), /Type checking failed/);
    } },
  // Captured on PHP 8.5. A file that will not parse never runs, so there is no exception
  // and no stack - and the guess found no location at all for it.
  { file: "php_parse_fail.txt", tool: "php", n: 1, check: (r) => {
      assert.equal(r.failures[0].line, 2);
      assert.match(r.failures[0].file, /p2\.php$/);
      assert.match(r.failures[0].message, /^syntax error, unexpected token "\{"/);
      assert.equal(r.failures[0].label, "parse error");
      assert.equal(r.failures[0].code, undefined);
    } },
  { file: "php_require_fail.txt", tool: "php", n: 1, check: (r) => {
      // The include path is longer than the diagnosis and never varies, while the file
      // it could not find is the answer.
      assert.doesNotMatch(r.failures[0].message, /include_path/);
      assert.match(r.failures[0].message, /^Failed opening required 'nothing-here\.php'$/);
      assert.equal(r.failures[0].code, "Error");
    } },
  // `terraform init` does not draw a box - it writes the error flat, with the prose
  // under it and no location at all, because nothing has been parsed yet. init is the
  // first command anyone runs and the one that fails on a bad provider or an
  // unreachable backend, and it was coming back as a guess.
  { file: "terraform_init_fail.txt", tool: "terraform", n: 1, check: (r) => {
      assert.equal(r.failures[0].title, "Invalid provider registry host");
      assert.match(r.failures[0].message, /^The host "example\.com"/);
      // the prose is separated from the header by a blank line, which cannot end it
      assert.match(r.failures[0].message, /does not offer a Terraform provider registry/);
      assert.equal(r.failures[0].file, undefined, "init runs before anything is parsed");
    } },
  // A file that will not compile never runs, so there is no traceback and no frames -
  // just where the parser gave up. Its location line is a traceback frame's shape
  // WITHOUT the ", in <name>" a frame always carries, which is what separates them.
  // One of the commonest ways a Python run fails, and it was reaching the guess.
  { file: "py_syntax_fail.txt", tool: "python", n: 1, check: (r) => {
      assert.match(r.failures[0].file, /syn\.py$/);
      assert.equal(r.failures[0].line, 1);
      assert.equal(r.failures[0].code, "SyntaxError");
      assert.equal(r.failures[0].message, "invalid syntax");
      assert.equal(r.failures[0].stmt, "def f(:");
    } },
  { file: "py_indent_fail.txt", tool: "python", n: 1, check: (r) => {
      assert.equal(r.failures[0].code, "IndentationError");
      assert.equal(r.failures[0].line, 3);
    } },
  // npm leads every line of its own output with "npm ", which is a uniform prefix by any
  // measure. In a log where npm was not the only tool, taking it off left npm's parser
  // matching nothing and handed the log to whoever was next.
  { file: "npm_eresolve_fail.txt", tool: "npm", n: 1, check: (r) => {
      assert.equal(r.failures[0].code, "ERESOLVE");
      assert.match(r.failures[0].message, /unable to resolve dependency tree/);
      assert.equal(r.wrappers, undefined, "npm's own prefix is not a wrapper");
    } },
  // Captured with lessc 4. It puts the class, the message, the file, the line and the
  // column all on the header line, with the position as prose at the end.
  { file: "less_fail.txt", tool: "less", n: 1, check: (r) => {
      assert.match(r.failures[0].file, /bad\.less$/);
      assert.equal(r.failures[0].line, 1);
      assert.equal(r.failures[0].col, 13);
      assert.equal(r.failures[0].code, "NameError");
      assert.equal(r.failures[0].message, "variable @undefined-var is undefined");
      // the location is prose inside the header and must not be left in the message
      assert.doesNotMatch(r.failures[0].message, /on line|column/);
    } },
  // Captured with @swc/cli 0.7. swc reports through miette, the Rust diagnostic
  // renderer, and ends with a tally that says nothing - which is what was being read,
  // under node's name, losing both the message and the location.
  { file: "swc_fail.txt", tool: "swc", n: 1, check: (r) => {
      assert.equal(r.failures[0].file, "swcbad.js");
      assert.equal(r.failures[0].line, 1);
      assert.equal(r.failures[0].message, "Expression expected");
      assert.equal(r.failures[0].stmt, "const x = ;");
      assert.doesNotMatch(JSON.stringify(r), /Failed to compile/);
    } },
  // Captured with @babel/cli 7. Babel names the file inside its message and follows the
  // code frame with its own parser's stack - twenty frames of @babel/parser.
  { file: "babel_fail.txt", tool: "babel", n: 1, check: (r) => {
      assert.match(r.failures[0].file, /bad\.jsx$/);
      assert.equal(r.failures[0].line, 1);
      assert.equal(r.failures[0].col, 10);
      assert.equal(r.failures[0].message, "Unexpected token");
      assert.equal(r.failures[0].stmt, "const x = ;");
      // none of babel's own frames reach the reader
      assert.doesNotMatch(JSON.stringify(r.failures), /@babel\/parser|node_modules/);
    } },
  // Captured with dart-sass 1.9x. sass puts its message at the head of a drawn box and
  // the location at the foot, so reading the first line found the problem and never
  // where it was.
  { file: "sass_fail.txt", tool: "sass", n: 1, check: (r) => {
      assert.equal(r.failures[0].file, "bad.scss");
      assert.equal(r.failures[0].line, 2);
      assert.equal(r.failures[0].col, 10);
      assert.equal(r.failures[0].message, "Undefined variable.");
      assert.equal(r.failures[0].stmt, "color: $undefined-var;");
    } },
  { file: "sass_import_fail.txt", tool: "sass", n: 1, check: (r) => {
      assert.equal(r.failures[0].line, 1);
      assert.match(r.failures[0].message, /Can't find stylesheet to import/);
    } },
  // Captured with webpack 5. Each error is followed by the resolver's entire search -
  // forty lines of how webpack looked rather than what went wrong.
  { file: "webpack_resolve_fail.txt", tool: "webpack", n: 1, check: (r) => {
      assert.equal(r.failures[0].file, "./wsrc/index.js");
      assert.equal(r.failures[0].line, 1);
      assert.match(r.failures[0].message, /^Module not found: Can't resolve '\.\/missing\.js'/);
      // "Module not found: Error: Can't resolve" says the same thing twice
      assert.doesNotMatch(r.failures[0].message, /Error:/);
      // none of the resolver's diary reaches the reader
      assert.doesNotMatch(JSON.stringify(r.failures), /description file|alias configuration/);
    } },
  { file: "webpack_parse_fail.txt", tool: "webpack", n: 1, check: (r) => {
      assert.match(r.failures[0].message, /^Module parse failed/);
      assert.equal(r.failures[0].stmt, "const x = ;");
      // the loader advice is a suggestion, not what happened
      assert.doesNotMatch(JSON.stringify(r.failures), /appropriate loader|webpack\.js\.org/);
    } },
  // Captured with prettier 3. It exits non-zero while naming only files.
  { file: "prettier_fail.txt", tool: "prettier", n: 1, check: (r) => {
      assert.equal(r.failures[0].file, "ugly.js");
      // "needs formatting" reads like nothing went wrong; the guarantees suite says so
      assert.match(r.summary, /failed the format check/);
      // the last [warn] line is prettier's advice, not another file
      assert.doesNotMatch(JSON.stringify(r.failures), /--write/);
    } },
  // Captured with flake8 7. One finding per line and nothing else.
  { file: "flake8_fail.txt", tool: "flake8", n: 8, check: (r) => {
      assert.equal(r.failures[0].file, "lint_me.py");
      assert.equal(r.failures[0].line, 1);
      assert.equal(r.failures[0].code, "F401");
      assert.equal(r.failures[0].message, "'os' imported but unused");
    } },
  // Captured with pylint 3. It reports conventions and refactor suggestions alongside
  // real errors, and only E and F stop a run.
  { file: "pylint_fail.txt", tool: "pylint", n: 4, check: (r) => {
      // this run found nothing but conventions and warnings - and still failed, so all
      // four are reported rather than none
      assert.equal(r.failures[0].code, "C0114");
      // the symbolic name is what goes in a disable comment and what the docs are
      // indexed by, so it leads; the numeric code identifies
      assert.equal(r.failures[0].title, "missing-module-docstring");
    } },
  { file: "pylint_error_fail.txt", tool: "pylint", n: 1, check: (r) => {
      // a real error alongside a missing docstring buries the error, so the advice
      // steps aside and is counted
      assert.equal(r.failures[0].code, "E0602");
      assert.equal(r.failures[0].title, "undefined-variable");
      assert.match(r.summary, /3 advisory hidden/);
    } },
  // Captured with black 25. It names files and exits non-zero, saying nothing that
  // admits a failure - which is also why its wording had to join the capture vocabulary.
  { file: "black_fail.txt", tool: "black", n: 1, check: (r) => {
      assert.equal(r.failures[0].file, "ugly.py");
      assert.match(r.summary, /failed the format check/);
    } },
  { file: "black_parse_fail.txt", tool: "black", n: 1, check: (r) => {
      // a file black cannot parse is reported differently, with the reason and where
      assert.equal(r.failures[0].file, "cantparse.py");
      assert.equal(r.failures[0].line, 1);
      assert.match(r.failures[0].message, /^Cannot parse/);
    } },
  // Captured with Biome 2. It heads each finding with the rule path, says what is wrong
  // on the next line, and then offers advice and a fix diff - neither of which is the
  // diagnosis.
  { file: "biome_fail.txt", tool: "biome", n: 1, check: (r) => {
      // This log says "Found 2 errors. Found 1 warning." and used to come back as the
      // one WARNING: only a section headed by a rule path was read, and biome heads a
      // file it could not parse with `parse` instead. The error is the answer here -
      // the variable is unused because the statement never parsed.
      assert.equal(r.failures[0].file, "biomebad.js");
      assert.equal(r.failures[0].line, 1);
      assert.equal(r.failures[0].col, 11);
      assert.equal(r.failures[0].code, "parse");
      assert.match(r.failures[0].message, /Expected an expression/);
      assert.match(r.summary, /1 warning hidden/);
      // Biome's second error is "Code formatting aborted due to parsing errors", which
      // is the parse error again wearing a different hat.
      assert.doesNotMatch(JSON.stringify(r.failures), /formatting aborted/);
      // the "i" lines are advice and the diff under them is the fix
      assert.doesNotMatch(JSON.stringify(r.failures), /often the result of typos|prepend x with/);
    } },
  // Captured with oxlint 1. The whole finding is one line, with the fix suggestion
  // appended to the message rather than kept apart from it.
  { file: "oxlint_fail.txt", tool: "oxlint", n: 1, check: (r) => {
      assert.equal(r.failures[0].file, "lintme.js");
      assert.equal(r.failures[0].col, 5);
      // the rule is what you would disable; the plugin qualifier is not part of its name
      assert.equal(r.failures[0].code, "no-unused-vars");
      assert.match(r.failures[0].message, /^Variable 'unused' is declared but never used/);
      assert.doesNotMatch(r.failures[0].message, /help:/);
    } },
  // Captured with stylelint 16. It reports like eslint but marks severity with a glyph
  // rather than a word, which is why eslint's own parser never saw it.
  { file: "stylelint_fail.txt", tool: "stylelint", n: 3, check: (r) => {
      assert.equal(r.failures[0].file, "style.css");
      assert.equal(r.failures[0].line, 1);
      assert.equal(r.failures[0].col, 8);
      // the rule name is what you would disable or search for
      assert.equal(r.failures[0].code, "property-no-unknown");
      assert.equal(r.failures[0].message, 'Unknown property "colr"');
      // the fourth problem is a warning and did not fail the run
      assert.match(r.summary, /1 warning hidden/);
      assert.doesNotMatch(JSON.stringify(r.failures), /Duplicate property/);
    } },
  // Captured with node-tap 21. TAP 14, which `node --test` also emits - they are told
  // apart by the YAML: tap writes an `at:` block, node writes `failureType`.
  { file: "tap_fail.txt", tool: "tap", n: 2, check: (r) => {
      assert.equal(r.failures[0].subject, "totals an invoice");
      assert.equal(r.failures[0].line, 2);
      assert.equal(r.failures[0].col, 3);
      // tap gives the values as a unified diff rather than as found/wanted fields
      assert.equal(r.failures[0].message, "-1050\n+1049");
      // and marks the failing line under `source:` with a --^ pointer
      assert.match(r.failures[0].stmt, /^t\.equal\(1049, 1050/);
      // the file-level line is a count of failures, not one of them
      assert.doesNotMatch(JSON.stringify(r.failures), /time=/);
    } },
  // Captured with jasmine 5. Another runner that produced no diagnosis at all.
  { file: "jasmine_fail.txt", tool: "jasmine", n: 2, check: (r) => {
      assert.equal(r.summary, "2 of 2 specs failed");
      assert.equal(r.failures[0].subject, "invoice finds an expiry claim");
      assert.equal(r.failures[0].message, "Expected undefined to be defined.");
      assert.match(r.failures[0].file, /sum\.spec\.js$/);
      assert.equal(r.failures[0].line, 3);
      // jasmine's own frames read "at <Jasmine>" and name no file, so the frame that
      // survives is always one of yours
      assert.doesNotMatch(JSON.stringify(r.failures), /<Jasmine>/);
    } },
  // Captured with markdownlint-cli 0.4x. One line per violation and nothing else.
  { file: "markdownlint_fail.txt", tool: "markdownlint", n: 2, check: (r) => {
      assert.equal(r.failures[0].file, "doc.md");
      assert.equal(r.failures[0].line, 3);
      assert.equal(r.failures[0].code, "MD018");
      assert.equal(r.failures[0].message, "No space after hash on atx style heading");
      // the bracketed context is the rule quoting your file back at you
      assert.doesNotMatch(JSON.stringify(r.failures), /\[Context:/);
      assert.equal(r.failures[1].code, "MD030");
    } },
  // Captured with ava 6. Like mocha, a failing run produced no diagnosis at all.
  { file: "ava_fail.txt", tool: "ava", n: 2, check: (r) => {
      assert.equal(r.summary, "2 tests failed");
      assert.equal(r.failures[0].subject, "totals an invoice");
      assert.equal(r.failures[0].line, 3);
      // a comparison reports the diff, not the test name back at you
      assert.equal(r.failures[0].message, "- 1049\n+ 1050");
      // an assertion that is NOT a comparison says so in prose, with the value under it
      // - and ava puts a blank line between the two
      assert.equal(r.failures[1].message, "Value is not truthy\nundefined");
      assert.equal(r.failures[1].line, 4);
      // the echoed source around the failing line is context, never the diagnosis
      assert.doesNotMatch(JSON.stringify(r.failures), /reduce\(/);
    } },
  { file: "ava_throw_fail.txt", tool: "ava", n: 1, check: (r) => {
      // a throw is located from its stack; ava's own pointer is not written for one
      assert.match(r.failures[0].file, /throw\.test\.js$/);
      assert.equal(r.failures[0].line, 2);
      assert.equal(r.failures[0].message, "payment gateway unreachable");
      // the site that failed is the test, so that is the subject - the thrown class
      // names the failure in the title rather than competing to be its identity
      assert.equal(r.failures[0].subject, "charges a card");
      assert.equal(r.failures[0].code, undefined);
      assert.match(r.failures[0].title, /\(Error\)/);
      // ava's own lib frames are under every throw and are never the answer
      assert.doesNotMatch(JSON.stringify(r.failures), /node_modules/);
    } },
  { file: "ava_load_fail.txt", tool: "ava", n: 1, check: (r) => {
      // a file that will not load never reaches the roll-call
      assert.match(r.failures[0].file, /syn\.test\.js$/);
      assert.equal(r.failures[0].code, "SyntaxError");
      assert.equal(r.failures[0].message, "Unexpected end of input");
    } },
  // Captured with mocha 11. A failing run produced no diagnosis at all before this -
  // not a worse answer, nothing - and mocha is among the most widely used JS runners.
  { file: "mocha_fail.txt", tool: "mocha", n: 2, check: (r) => {
      assert.equal(r.summary, "2 failing, 1 passing");
      assert.equal(r.failures[0].file, "test/sum.test.js");
      assert.equal(r.failures[0].line, 6);
      // the suite and the test are on separate lines; the reader wants both
      assert.equal(r.failures[0].subject, "invoice totals an invoice");
      assert.match(r.failures[0].message, /Expected values to be strictly equal/);
      assert.match(r.failures[1].message, /token should carry exp/);
      // node's own frames are under every one of these and are never the answer
      assert.doesNotMatch(JSON.stringify(r.failures), /node:internal/);
    } },
  { file: "mocha_hook_fail.txt", tool: "mocha", n: 1, check: (r) => {
      // a hook that throws is named for the hook, and the message is the throw - not
      // the hook's name repeated back
      assert.match(r.failures[0].subject, /before all/);
      assert.equal(r.failures[0].message, "payment gateway unreachable");
      assert.equal(r.failures[0].line, 2);
    } },
  { file: "mocha_timeout_fail.txt", tool: "mocha", n: 1, check: (r) => {
      // a timeout unwinds entirely inside node's timers, so there is no frame of yours
      // to point at. Reporting node:internal/timers as the place your test failed is
      // worse than reporting no place at all.
      assert.equal(r.failures[0].file, undefined);
      assert.match(r.failures[0].message, /^Timeout of 50ms exceeded/);
      // mocha repeats the test file in that message; the location already said it
      assert.doesNotMatch(r.failures[0].message, /\(\//);
    } },
  { file: "mocha_load_fail.txt", tool: "mocha", n: 1, check: (r) => {
      // a file that will not load never reaches the tally, so there is no numbered
      // block - just mocha's own line over a Node stack
      assert.equal(r.failures[0].file, "/home/dev/app/test/syn.test.js");
      assert.equal(r.failures[0].line, 2);
      assert.equal(r.failures[0].code, "SyntaxError");
      assert.equal(r.failures[0].message, "Unexpected end of input");
    } },
  // Captured with go 1.25. `go vet` prefixes the line when the package will not compile
  // at all, and that prefix defeated the anchor - so a vet run that hit a type error came
  // back as a guess with no location, with the file and line sitting in plain sight
  // inside the message.
  { file: "govet_compile_fail.txt", tool: "go vet", n: 1, check: (r) => {
      assert.equal(r.failures[0].file, "main.go");
      assert.equal(r.failures[0].line, 6);
      assert.equal(r.failures[0].col, 17);
      assert.match(r.failures[0].message, /^cannot use 42 \(untyped int constant\)/);
      assert.doesNotMatch(r.failures[0].message, /^vet: /, "the prefix is not part of the message");
    } },
  { file: "govet_printf_fail.txt", tool: "go build", n: 2, check: (r) => {
      // Vet's own findings are written exactly like a compile error and carry no prefix,
      // so a piped log gives no way to tell them apart. Reported as the compiler's is
      // the honest reading of the text; the prefix above is the one time it does say.
      assert.equal(r.failures[0].line, 9);
      assert.match(r.failures[0].message, /fmt\.Printf call needs 1 arg but has 2 args/);
      assert.match(r.failures[1].message, /format %s has arg 42 of wrong type int/);
    } },
  // Captured on the system perl, 5.34. Perl puts the location at the end of the message,
  // in prose, so nothing recognised it and a failing perl script produced no diagnosis.
  { file: "perl_die_fail.txt", tool: "perl", n: 1, check: (r) => {
      assert.equal(r.failures[0].file, "p_die.pl");
      assert.equal(r.failures[0].line, 2);
      assert.equal(r.failures[0].message, "no price for item");
      assert.equal(r.summary, undefined, "a summary that repeats the only failure says it twice");
    } },
  { file: "perl_syn_fail.txt", tool: "perl", n: 1, check: (r) => {
      // "near \"= ;\"" is what the parser choked on - the useful half of a syntax error.
      assert.match(r.failures[0].message, /^syntax error \(near "= ;"\)$/);
      // "Execution of ... aborted due to compilation errors." restates it and is dropped
      assert.equal(r.failures.length, 1);
    } },
  { file: "perl_inc_fail.txt", tool: "perl", n: 1, check: (r) => {
      // The module search path is longer than the diagnosis and never varies.
      assert.doesNotMatch(r.failures[0].message, /@INC contains/);
      assert.match(r.failures[0].message, /Can't locate NoSuch\/Module\/Xyz\.pm/);
      assert.match(r.failures[0].message, /you may need to install the NoSuch::Module::Xyz module/);
      assert.equal(r.failures[0].line, 2, "BEGIN failed--compilation aborted is not a second failure");
    } },
  { file: "perl_undef_fail.txt", tool: "perl", n: 1, check: (r) => {
      assert.match(r.failures[0].message, /^Can't call method "render" on an undefined value$/);
    } },
  { file: "perl_warn_fail.txt", tool: "perl", n: 1, check: (r) => {
      // Perl marks nothing: a warning and a fatal die are written in exactly the same
      // shape. The only thing separating them is what the message says, so the warning
      // is matched by phrase - and the die, which is the failure, is what gets reported.
      assert.equal(r.failures[0].line, 7);
      assert.equal(r.failures[0].message, "cannot reach the billing service");
      assert.equal(r.summary, "1 error, 1 warning");
      assert.doesNotMatch(JSON.stringify(r.failures), /uninitialized/, "a warning was reported as a failure");
    } },
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
  // Ruby names the method between the location and the message, so there is no space
  // after the line number and nothing recognised it at all. It was read as a guess for a
  // while, which found the file and the line; a parser also gets the exception class,
  // which is the handle you would search for, and keeps the unwind.
  { file: "ruby_error_fail.txt", tool: "ruby", n: 1, check: (r) => {
      assert.equal(r.failures[0].file, "bad.rb");
      assert.equal(r.failures[0].line, 2);
      assert.match(r.failures[0].message, /undefined method .no_such_method./);
      assert.equal(r.failures[0].code, "NoMethodError");
      assert.doesNotMatch(r.failures[0].message, /NoMethodError/, "the class was left in the message too");
      // `trace` is rendered as text, one frame per line. Asserting only its length let a
      // version through that put objects in it, and every frame printed as
      // "at [object Object]" - which only running the CLI showed.
      assert.deepEqual(r.failures[0].trace, ["f (bad.rb:2)", "<main> (bad.rb:4)"]);
    } },
  // Captured on the system ruby, 2.6.10.
  { file: "ruby_keyerror_fail.txt", tool: "ruby", n: 1, check: (r) => {
      assert.equal(r.failures[0].file, "deep.rb");
      assert.equal(r.failures[0].line, 3);
      assert.equal(r.failures[0].code, "KeyError");
      assert.equal(r.failures[0].message, "key not found: :price");
      assert.deepEqual(r.failures[0].trace, [
        "fetch (deep.rb:3)", "block in total (deep.rb:3)", "map (deep.rb:3)", "total (deep.rb:3)",
      ], "the unwind through map and total is the story");
      assert.ok(r.failures[0].trace.every((t) => typeof t === "string"), "trace must render as text");
    } },
  { file: "ruby_nomethod_fail.txt", tool: "ruby", n: 1, check: (r) => {
      // Ruby offers a correction under a NameError, and it is the answer often enough
      // to be worth keeping beside the message.
      assert.match(r.failures[0].message, /Did you mean\? case/);
    } },
  { file: "ruby_syntax_fail.txt", tool: "ruby", n: 1, check: (r) => {
      // A file that will not parse never runs, so there is no exception and no unwind.
      assert.equal(r.failures[0].file, "syn.rb");
      assert.equal(r.failures[0].line, 3);
      assert.equal(r.failures[0].code, undefined);
      assert.match(r.failures[0].message, /^syntax error/);
    } },
  { file: "ruby_require_fail.txt", tool: "ruby", n: 1, check: (r) => {
      // A failing `require` is raised inside rubygems, so the deepest frame is the
      // stdlib. Reporting kernel_require.rb:54 is true and useless; the line that
      // asked for the gem is the one to open.
      assert.equal(r.failures[0].file, "ld.rb");
      assert.equal(r.failures[0].line, 1);
      assert.equal(r.failures[0].code, "LoadError");
      assert.match(r.failures[0].message, /cannot load such file -- definitely_not_a_gem_xyz/);
      // both rubygems frames are counted, not listed: none of them is yours
      assert.deepEqual(r.failures[0].trace, ["<main> (ld.rb:1)"]);
      assert.equal(r.failures[0].hiddenFrames, 2);
    } },
  { file: "ruff_syntax_fail.txt", tool: "ruff", n: 1, check: (r) => {
      // A file ruff cannot parse is reported without a rule code, so requiring one
      // meant a run saying "Found 1 error." came back with none - the ordinary case of
      // running ruff over a file with a typo in it.
      assert.equal(r.failures[0].code, "invalid-syntax");
      assert.equal(r.failures[0].file, "syn.py");
      assert.equal(r.failures[0].line, 1);
      assert.equal(r.summary, "1 error", "one error is not 1 errors");
    } },
  { file: "mypy_missing_fail.txt", tool: "mypy", n: 1, check: (r) => {
      // mypy reports a problem with its own invocation with no file:line at all.
      assert.match(r.failures[0].message, /Cannot read file 'nofile\.py'/);
      assert.equal(r.failures[0].file, undefined);
    } },
  // A program that crashes outside a test run. Both languages report it the same way -
  // a message, then a stack that is mostly the runtime's own machinery.
  { file: "gopanic_fail.txt", tool: "go", n: 1, check: (r) => {
      // `go run` output has no test tally and no --- FAIL line, so nothing in the
      // detector fired and this produced no diagnosis at all.
      assert.equal(r.summary, "panic");
      assert.equal(r.failures[0].file, "/home/dev/m3/main.go");
      assert.equal(r.failures[0].line, 7);
      assert.match(r.failures[0].message, /index out of range \[5\] with length 0/);
      assert.equal(r.failures[0].category, "runtime");
    } },
  { file: "node_syntax_fail.txt", tool: "node", n: 1, check: (r) => {
      // A syntax error's stack is entirely node's own machinery; the only place the
      // real location appears is the header above the caret.
      assert.equal(r.failures[0].file, "/home/dev/m3/syn.mjs");
      assert.equal(r.failures[0].line, 1);
      assert.doesNotMatch(String(r.failures[0].file), /^file:\/\//, "a URL is not a path");
      assert.doesNotMatch(String(r.failures[0].file), /node:internal/);
    } },
  { file: "node_import_fail.txt", tool: "node", n: 1, check: (r) => {
      // Here even the header is node's own file. No location at all beats a location
      // inside the runtime, which reads as though the bug were in node.
      assert.equal(r.failures[0].file, undefined);
      assert.match(r.failures[0].message, /Cannot find module/);
      assert.doesNotMatch(JSON.stringify(r.failures), /node:internal\/modules/);
    } },
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
  // A parser that reads one failure mode well can fall over on another. These four are
  // real captures of the modes that are not "a test failed": a config that will not
  // load, a suite that throws before any test runs, a module that will not import.
  { file: "tsc_config_fail.txt", tool: "tsc", n: 3, check: (r) => {
      // TS18003 has no file(line,col) prefix at all, so requiring one dropped it: a run
      // that reported three errors came back with two, silently.
      assert.ok(r.failures.some((f) => f.code === "TS18003" && !f.file),
        "a config-level error belongs to no file and was being dropped");
      assert.equal(r.failures.filter((f) => f.file).length, 2);
    } },
  { file: "jest_suite_fail.txt", tool: "jest", n: 1, check: (r) => {
      // jest's tally reads "Tests: 0 total" when the suite never ran, and a headline of
      // "0 total" over a real failure reads as though nothing happened.
      assert.match(r.summary, /1 failed, 1 total \(no tests ran\)/);
      assert.doesNotMatch(r.summary, /^0 total$/);
      assert.equal(r.failures[0].file, "crash.test.js");
      assert.match(r.failures[0].message, /suite blew up before any test ran/);
    } },
  { file: "eslint_config_fail.txt", tool: "eslint", n: 1, check: (r) => {
      // A broken config makes eslint crash, and the stack points into its own internals.
      assert.equal(r.summary, "configuration error");
      assert.match(r.failures[0].message, /Could not find "no-such-rule"/);
      assert.equal(r.failures[0].file, undefined, "eslint's own internals are not the answer");
      assert.doesNotMatch(JSON.stringify(r), /node_modules/);
    } },
  { file: "pytest_collect_fail.txt", tool: "pytest", n: 1, check: (r) => {
      assert.match(r.failures[0].message, /ModuleNotFoundError: No module named 'nonexistent_module'/);
      assert.doesNotMatch(JSON.stringify(r.failures), /importlib|_bootstrap/,
        "python's own import machinery is not the cause");
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
  // Captured from real git 2.x runs. git prints mostly advice: a conflict ends with
  // "Automatic merge failed; fix conflicts and then commit the result", which is the
  // mechanism, and a rejected push buries the one useful line under five hint: lines.
  { file: "git_conflict_fail.txt", tool: "git", n: 2, check: (r) => {
      assert.equal(r.summary, "2 conflicted files");
      assert.deepEqual(r.failures.map((f) => f.file), ["a.txt", "b.txt"], "the files are the answer");
      assert.equal(r.failures[0].label, "merge conflict");
      assert.equal(r.failures[0].category, "vcs");
      assert.doesNotMatch(JSON.stringify(r.failures), /Automatic merge failed|Auto-merging/,
        "the mechanism and the progress lines are not failures");
    } },
  { file: "git_overwrite_fail.txt", tool: "git", n: 1, check: (r) => {
      assert.equal(r.failures[0].file, "a.txt", "the file that would be lost is the answer");
      assert.match(r.failures[0].message, /would be overwritten by merge/);
      assert.doesNotMatch(JSON.stringify(r.failures), /Please commit|Aborting|Updating/);
    } },
  { file: "git_reject_fail.txt", tool: "git", n: 1, check: (r) => {
      assert.equal(r.failures[0].label, "rejected");
      assert.match(r.failures[0].message, /main -> main \(fetch first\)/);
      // "failed to push some refs" only restates the rejection above it
      assert.doesNotMatch(JSON.stringify(r.failures), /failed to push some refs|^hint:/m);
    } },
  { file: "git_norepo_fail.txt", tool: "git", n: 1, check: (r) => {
      assert.equal(r.failures[0].label, "fatal");
      assert.match(r.failures[0].message, /not a git repository/);
    } },
  // Captured from real `docker build` runs on Docker 29.6.2 (BuildKit), one failing an
  // npm script and one failing pytest. A failing build otherwise reports only
  // "ERROR: failed to build: failed to solve", which names the mechanism, not the cause.
  { file: "docker_buildkit_npm_fail.txt", tool: "npm", n: 1, check: (r) => {
      assert.match(r.failures[0].message, /Missing script: "nonexistent-script"/);
      assert.doesNotMatch(JSON.stringify(r), /failed to solve/, "the mechanism is not the cause");
      // npm's failure is five lines inside a twenty-line frame. It used to be lifted
      // out by its own markers, because the step prefix was only counted on lines
      // carrying an elapsed column and so covered too little of the log to strip. It
      // now counts BuildKit's other line forms too and clears the gate. The region
      // fallback stays for a log the prefix genuinely cannot cover - a build that is
      // mostly pull progress - and is exercised directly in test/normalize.js.
      assert.deepEqual(r.wrappers, ["docker"]);
    } },
  { file: "docker_buildkit_pytest_fail.txt", tool: "pytest", n: 2, check: (r) => {
      assert.equal(r.failures[0].file, "test_shop.py");
      assert.equal(r.failures[0].line, 5);
      assert.match(r.failures[1].message, /KeyError: 'exp'/);
      assert.doesNotMatch(JSON.stringify(r), /failed to solve/, "the mechanism is not the cause");
      assert.deepEqual(r.wrappers, ["docker"]);
      // the pip install step above it succeeded; nothing there is a failure
      assert.equal(r.others, undefined, "the pip install step is not a second tool's failure");
    } },
  // Captured from Apple Swift 6.x. swiftc writes clang's diagnostic shape and then draws
  // the source underneath it - a numbered echo, and an annotation hanging off the column
  // that repeats the message word for word. Only the header is the diagnostic; reading
  // the annotation too reported four errors for two.
  { file: "swiftc_fail.txt", tool: "swift", n: 2, check: (r) => {
      assert.equal(r.failures[0].file, "mixed.swift");
      assert.equal(r.failures[0].line, 10);
      assert.equal(r.failures[0].col, 14);
      assert.match(r.failures[0].message, /cannot convert value of type 'String'/);
      // the echoed source is the line the diagnostic points at, not the one beside it
      assert.equal(r.failures[0].stmt, 'let x: Int = "hello"');
      assert.match(r.failures[1].message, /cannot find 'y' in scope/);
      // the warning is counted, not reported: it did not fail the build
      assert.equal(r.summary, "2 errors, 1 warning");
      assert.doesNotMatch(JSON.stringify(r.failures), /never used/, "a warning was reported as a failure");
      // the diagnostic group is the handle you would silence or search for
      assert.doesNotMatch(JSON.stringify(r.failures), /\[#/, "the group tag stayed in the message");
    } },
  // A conformance error is the case that produces the most notes, and swiftc 6 draws all
  // of them inside the gutter annotation rather than as standalone "file:line: note:"
  // headers. Three notes here, and none of them is a failure.
  { file: "swiftc_conformance_fail.txt", tool: "swift", n: 1, check: (r) => {
      assert.match(r.failures[0].message, /^type 'Invoice' does not conform to protocol 'Payable'$/);
      assert.equal(r.failures[0].line, 5);
      assert.doesNotMatch(JSON.stringify(r.failures), /note:/, "an annotation note was read as a failure");
      assert.doesNotMatch(JSON.stringify(r.failures), /add stubs for conformance/);
    } },
  { file: "swiftc_bulk_fail.txt", tool: "swift", n: 9, check: (r) => {
      // Eight assignments of the same wrong type, and one unrelated error. That is one
      // cause with eight sites, not nine things to read - but the eight were listed one
      // by one, four of them behind a "... 4 more".
      //
      // The cluster key drops the echoed source line when the failure carries a `code`,
      // because for a compiler the statement is the INSTANCE. swiftc gives no code for
      // these, so the key kept "let v1: Int = ..." and every one of them was unique.
      // The rule is about being a compiler, not about the tool having handed out a code:
      // clang got the right answer only because it happens to set no stmt at all.
      const reported = r.clusters.filter((c) => c.reported);
      assert.equal(reported.length, 1, "eight identical type errors are one cause");
      assert.equal(reported[0].size, 8);
      // and the unrelated one is not swept in with them
      const alone = r.clusters.find((c) => c.size === 1);
      assert.ok(alone, "the lone 'cannot find in scope' error must stay separate");
      assert.match(r.failures[alone.exemplar].message, /cannot find 'missingSymbol' in scope/);
    } },
  { file: "swiftc_driver_fail.txt", tool: "swift", n: 1, check: (r) => {
      // swiftc writes a placeholder location rather than none, and doubles the word:
      // "<unknown>:0: error: error opening input file 'nosuch.swift' (...)"
      assert.equal(r.failures[0].file, undefined, "<unknown> is not a file");
      assert.match(r.failures[0].message, /^error opening input file 'nosuch\.swift'/);
      // mypy's "file:line: error:" shape matches "<unknown>:0: error:" exactly, and a
      // mypy run pasted above this claimed it as a type error. mypy reports only Python.
      assert.doesNotMatch(r.failures[0].message, /^error: /, "the doubled word survived");
    } },
  // Captured with GNU make 3.81 driving Apple clang. What fails under make is a
  // compiler, which already has a parser, and `make: *** [bad.o] Error 1` restates that
  // without adding to it - so make's parser declines these logs entirely.
  { file: "make_compile_fail.txt", tool: "clang", n: 3, check: (r) => {
      assert.equal(r.failures[0].file, "bad.c");
      assert.equal(r.failures[0].line, 3);
      assert.equal(r.failures[0].code, "-Wint-conversion");
      assert.doesNotMatch(JSON.stringify(r.failures), /make: \*\*\*/, "make's echo is not a failure");
    } },
  { file: "make_driver_fail.txt", tool: "clang", n: 1, check: (r) => {
      // The driver failed before it could compile anything, so there is no file:line to
      // report - and "no input files" underneath only restates it.
      assert.match(r.failures[0].message, /no such file or directory: 'nonexistent\.c'/);
      assert.equal(r.failures[0].file, undefined);
      assert.equal(r.failures[0].severity, "error");
      assert.doesNotMatch(JSON.stringify(r.failures), /no input files|make: \*\*\*/);
    } },
  // Captured with GNU make 4.4.1 on Debian, and 3.81 on macOS for the two shapes that
  // differ. make ends a line "Stop." when make itself is refusing to continue, and
  // "Error N" when it is only relaying somebody else's exit status - which is the whole
  // basis for what this parser reads. 4.x quotes 'like this' where 3.81 wrote `like
  // this', so both fixtures are kept rather than one being assumed to stand for both.
  { file: "make_separator_fail.txt", tool: "make", n: 1, check: (r) => {
      assert.equal(r.failures[0].file, "Makefile");
      assert.equal(r.failures[0].line, 2);
      assert.equal(r.failures[0].message, "missing separator.");
      assert.equal(r.failures[0].label, "makefile error", "make prints no codes");
    } },
  { file: "make_function_fail.txt", tool: "make", n: 1, check: (r) => {
      assert.equal(r.failures[0].line, 1);
      assert.match(r.failures[0].message, /unterminated call to function/);
    } },
  { file: "make_norule_fail.txt", tool: "make", n: 1, check: (r) => {
      assert.equal(r.failures[0].subject, "missing.o", "the target it could not build");
      assert.match(r.failures[0].message, /needed by 'all'/);
    } },
  { file: "make_norule_bsdquote_fail.txt", tool: "make", n: 1, check: (r) => {
      // GNU make 3.81 writes `missing.o' - a backquote opening a straight quote.
      assert.equal(r.failures[0].subject, "missing.o");
    } },
  { file: "make_command_fail.txt", tool: "make", n: 1, check: (r) => {
      assert.equal(r.failures[0].subject, "this-command-does-not-exist");
      assert.doesNotMatch(JSON.stringify(r.failures), /Error 127/,
        "the exit status make relayed is not a second failure");
    } },
  { file: "make_include_fail.txt", tool: "make", n: 1, check: (r) => {
      // make says it twice: once against the line that included the file, then again as
      // a target it cannot build. The first one knows where the problem is written.
      assert.equal(r.failures[0].file, "Makefile");
      assert.equal(r.failures[0].line, 1);
      assert.equal(r.failures[0].subject, "nope.mk");
    } },
  { file: "make_nested_fail.txt", tool: "clang", n: 1, check: (r) => {
      // gcc's diagnostics share clang's shape, and clang's parser reads them.
      assert.equal(r.failures[0].file, "bad.c");
      // Two levels of make each report the failure on the way up. Reading either as a
      // failure would turn one compiler error into three.
      assert.doesNotMatch(JSON.stringify(r.failures), /make(\[\d+\])?: \*\*\*|Entering directory/,
        "make relaying an exit status upward is not a failure");
    } },
  // Captured with pnpm 9 and yarn 1.22. pnpm indents its diagnostics with U+2009 THIN
  // SPACE, not a space - a pattern written [ \t] matches none of it, which is how the
  // whitespace class used across every parser came to be wrong.
  { file: "pnpm_script_fail.txt", tool: "pnpm", n: 1, check: (r) => {
      const raw = fx("pnpm_script_fail.txt");
      assert.ok(raw.includes("\u2009"), "this fixture exists because pnpm uses a thin space");
      assert.equal(r.failures[0].code, "ERR_PNPM_NO_SCRIPT");
      assert.match(r.failures[0].message, /Missing script: nonexistent-script/);
      assert.equal(r.failures[0].category, "package");
    } },
  { file: "pnpm_lifecycle_fail.txt", tool: "pnpm", n: 1, check: (r) => {
      assert.equal(r.failures[0].code, "ELIFECYCLE");
      assert.match(r.failures[0].message, /Command failed with exit code 3/);
      // the WARN line underneath is advice, not a failure
      assert.doesNotMatch(JSON.stringify(r.failures), /node_modules missing/);
    } },
  { file: "yarn_fail.txt", tool: "yarn", n: 1, check: (r) => {
      assert.match(r.failures[0].message, /Command failed with exit code 3/);
      // yarn ends with a documentation link; that is not a diagnosis
      assert.doesNotMatch(JSON.stringify(r.failures), /yarnpkg\.com/);
    } },
  // Captured with esbuild 0.27 and vite 8.2. Both wrap their real diagnostic in a Node
  // CLI stack reporting that the bundler exited non-zero; that stack is the same failure
  // told worse, and before these parsers it was the only thing whatbroke showed.
  { file: "esbuild_syntax_fail.txt", tool: "esbuild", n: 1, check: (r) => {
      const f = r.failures[0];
      assert.equal(f.file, "src/app.js");
      assert.equal(f.line, 5);
      assert.equal(f.col, 24);
      assert.match(f.message, /Expected "\)" but found ";"/);
      assert.match(f.stmt, /return sum \* \(1 \+ rate;/);
      assert.doesNotMatch(JSON.stringify(r), /node:internal/, "the wrapper's stack is not the failure");
    } },
  { file: "esbuild_resolve_fail.txt", tool: "esbuild", n: 1, check: (r) => {
      assert.equal(r.failures[0].file, "src/clean.js");
      assert.match(r.failures[0].message, /Could not resolve "\.\/also-missing\.js"/);
      assert.equal(r.others, undefined, "the CLI wrapper's stack must not surface as a second tool");
    } },
  { file: "vite_syntax_fail.txt", tool: "vite", n: 1, check: (r) => {
      const f = r.failures[0];
      assert.equal(f.code, "PARSE_ERROR");
      assert.equal(f.file, "src/app.js");
      assert.equal(f.line, 5);
      assert.match(f.message, /Expected `,` or `\)` but found `;`/);
    } },
  { file: "vite_resolve_fail.txt", tool: "vite", n: 1, check: (r) => {
      const f = r.failures[0];
      assert.equal(f.code, "UNRESOLVED_IMPORT");
      assert.equal(f.file, "src/clean.js");
      assert.equal(f.line, 1);
      assert.match(f.message, /Could not resolve/);
    } },
  // Captured with pip 24.3.1 on Python 3.12: a build backend that raises, a version
  // that does not exist, and a malformed requirements file.
  { file: "pip_build_fail.txt", tool: "pip", n: 1, check: (r) => {
      // 42 lines of pip ceremony around one raised exception, stated twice.
      const f = r.failures[0];
      assert.equal(f.title, "build failed");
      assert.equal(f.subject, "./brokenpkg");
      assert.match(f.message, /RuntimeError: deliberate failure while building metadata/);
      assert.doesNotMatch(f.message, /pyproject_hooks|build_meta/, "setuptools' own frames are not the cause");
      assert.equal(f.category, "package");
    } },
  { file: "pip_resolve_fail.txt", tool: "pip", n: 1, check: (r) => {
      const f = r.failures[0];
      assert.equal(f.subject, "numpy==1.0.0");
      assert.equal(f.title, "no matching distribution");
      // pip says this twice and pads it with the whole index and two "Ignored" lines
      assert.doesNotMatch(f.message, /from versions:/, "the version list is the index, not the diagnosis");
      assert.doesNotMatch(f.message, /Ignored the following/);
    } },
  { file: "pip_badreq_fail.txt", tool: "pip", n: 1, check: (r) => {
      const f = r.failures[0];
      assert.equal(f.subject, "requests==");
      assert.equal(f.file, "bad.txt");
      assert.equal(f.line, 1);
      assert.match(f.message, /Expected end or semicolon/);
    } },
  // Captured with javac 26.0.2.1 (-Xlint:unchecked), Gradle 9.7.1 (Java plugin
  // with the same flag), and mypy 2.3.1 (--no-error-summary, with/without columns).
  { file: "javac_fail.txt", tool: "jvm", n: 1, check: (r) => {
      assert.equal(r.failures[0].file, "Main.java");
      assert.equal(r.failures[0].line, 5);
      assert.equal(r.failures[0].title, "compile error");
      assert.match(r.failures[0].message, /String cannot be converted to int/);
      assert.doesNotMatch(r.failures[0].message, /unchecked/);
    } },
  { file: "gradle_warnings_fail.txt", tool: "gradle", n: 1, check: (r) => {
      assert.equal(r.summary, "build failed");
      assert.equal(r.failures[0].line, 5);
      assert.match(r.failures[0].file, /Main\.java$/);
      assert.match(r.failures[0].message, /String cannot be converted to int/);
      assert.doesNotMatch(r.failures[0].message, /unchecked/);
      // severity used to be internal bookkeeping that jvm.js stripped before emitting.
      // It is now a declared field, so the guarantee changes from "absent" to "correct":
      // warnings must still never reach the failure list.
      assert.equal(r.failures[0].severity, "error", "a warning must not be reported as a failure");
    } },
  ...["mypy_no_summary_fail.txt", "mypy_columns_fail.txt"].map((file) => ({
    file, tool: "mypy", n: 2, check: (r) => {
      assert.equal(r.summary, "2 errors");
      assert.deepEqual(r.failures.map((f) => f.file), ["b.pyi", "a.py"]);
      for (const f of r.failures) {
        assert.equal(f.line, 1);
        assert.equal(f.col, file === "mypy_columns_fail.txt" ? 14 : undefined);
        assert.equal(f.title, "assignment");
        assert.match(f.message, /Incompatible types in assignment/);
      }
    },
  })),
  { file: "nodetest_nested_fail.txt", tool: "node --test", n: 3, check: (r) => {
      assert.equal(r.summary, "3 failed, 1 passed");
      assert.deepEqual(r.failures.map((f) => f.title), ["addition", "multiplication", "subtraction"]);
      assert.deepEqual(r.failures.map((f) => f.line), [5, 6, 8]);
      assert.ok(r.failures.every((f) => f.file.endsWith("/test/nested.test.cjs")));
      assert.match(r.failures[0].message, /2 !== 3/);
      assert.match(r.failures[1].message, /4 !== 5/);
      assert.match(r.failures[2].message, /6 !== 7/);
    } },
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
  // Captured with gcc 14 under -fno-show-column, which older gcc did by default. Without
  // the column, `file:line: error: message` is also javac's shape and mypy's - so the
  // filename is what has to identify the compiler, and only C-family sources qualify.
  { file: "gcc_nocolumn_fail.txt", tool: "clang", n: 1, check: (r) => {
      assert.equal(r.failures[0].file, "inc.c");
      assert.equal(r.failures[0].line, 1);
      assert.equal(r.failures[0].col, undefined, "no column was printed; none is invented");
      assert.match(r.failures[0].message, /nope\.h: No such file or directory/);
    } },
  { file: "gcc_nocolumn_multi_fail.txt", tool: "clang", n: 3, check: (r) => {
      assert.deepEqual(r.failures.map((f) => f.line), [2, 3, 4]);
      assert.equal(r.failures.every((f) => f.col === undefined), true);
      assert.equal(r.failures[1].code, "-Wimplicit-function-declaration");
      // gcc repeats the location as a "note" to say it will not warn again. It is not
      // a second failure, and it sits on the same line as the first.
      assert.doesNotMatch(JSON.stringify(r.failures), /reported only once/);
    } },
  // Captured with shellcheck 0.9 and yamllint 1.35 on Debian, each in both the format it
  // prints by default and its machine-readable one. Neither default format was readable:
  // the location and the message are on different lines, so no parser claimed either and
  // both runs came back "could not identify a diagnostic".
  { file: "shellcheck_fail.txt", tool: "shellcheck", n: 1, check: (r) => {
      // One error among seven findings. The rest rank below it and are set aside.
      assert.equal(r.failures[0].code, "SC2045");
      assert.equal(r.failures[0].file, "deploy.sh");
      assert.equal(r.failures[0].line, 4);
      // The carets are drawn under the offending span, so where they start is the column.
      assert.equal(r.failures[0].col, 10);
      assert.equal(r.failures[0].stmt, "for f in $(ls *.txt); do");
      assert.match(r.summary, /6 lower-severity findings hidden/);
    } },
  { file: "shellcheck_gcc_fail.txt", tool: "shellcheck", n: 1, check: (r) => {
      // The same run under -f gcc. It has to reach the same answer, column included -
      // which is the check that the caret arithmetic above is right and not merely
      // self-consistent. -f gcc prints no source line, so there is no stmt to quote.
      assert.equal(r.failures[0].code, "SC2045");
      assert.equal(r.failures[0].line, 4);
      assert.equal(r.failures[0].col, 10);
      assert.equal(r.failures[0].stmt, undefined);
    } },
  { file: "shellcheck_style_fail.txt", tool: "shellcheck", n: 3, check: (r) => {
      // shellcheck exits non-zero on style and info findings too, and a run that fails
      // on nothing worse is the common case. Saying nothing would be worse than saying
      // they are only style, so the headline says which kind they were.
      assert.match(r.summary, /^failed on 3 style\/info findings$/);
      assert.deepEqual(r.failures.map((f) => f.code), ["SC2006", "SC2116", "SC2086"]);
      // Two findings at one position are two findings; the code is what separates them.
      assert.deepEqual(r.failures.slice(0, 2).map((f) => `${f.line}:${f.col}`), ["2:8", "2:8"]);
      assert.equal(r.failures.every((f) => f.severity === "error"), true,
        "a failure marked warning is a contradiction: these are why the run exited non-zero");
      assert.doesNotMatch(JSON.stringify(r.failures), /Did you mean|shellcheck\.net/);
    } },
  { file: "yamllint_fail.txt", tool: "yamllint", n: 4, check: (r) => {
      assert.deepEqual(r.failures.map((f) => f.file),
        ["app.yml", "app.yml", "app.yml", "broken.yml"], "the block header says which file");
      // The message carries brackets of its own, so the rule has to be matched as the
      // last parenthesised word rather than as whatever is inside the final brackets.
      assert.equal(r.failures[1].code, "line-length");
      assert.equal(r.failures[1].message, "line too long (106 > 80 characters)");
      // yamllint exits zero on a run that found only warnings, unlike shellcheck.
      assert.match(r.summary, /2 warnings hidden/);
    } },
  { file: "yamllint_parsable_fail.txt", tool: "yamllint", n: 4, check: (r) => {
      assert.deepEqual(r.failures.map((f) => f.code),
        ["key-duplicates", "line-length", "trailing-spaces", "syntax"]);
      assert.equal(r.failures[1].message, "line too long (106 > 80 characters)");
    } },
  // Captured with Docker 28 / BuildKit. Docker prints the offending Dockerfile line
  // inside a fenced excerpt and marks it with ">>>", and repeats each error once per
  // step and again at the end - so the fallback reported one failure twice and used
  // neither the file nor the line sitting directly above it.
  { file: "docker_dockerfile_fail.txt", tool: "docker", n: 1, check: (r) => {
      assert.equal(r.failures[0].file, "Dockerfile.syntax");
      assert.equal(r.failures[0].line, 2);
      assert.equal(r.failures[0].stmt, "RUNN echo hi");
      assert.match(r.failures[0].message, /unknown instruction: RUNN/);
    } },
  { file: "docker_pull_fail.txt", tool: "docker", n: 1, check: (r) => {
      // The step error names the cause; the line at the end restates it wrapped in
      // "failed to build: failed to solve:" and is not a second failure.
      assert.equal(r.failures[0].line, 1);
      assert.equal(r.failures[0].stmt, "FROM this-image-does-not-exist-xyz:9.9");
      assert.match(r.failures[0].message, /pull access denied/);
      assert.doesNotMatch(r.failures[0].message, /failed to solve/);
    } },
  { file: "docker_run_silent_fail.txt", tool: "docker", n: 1, check: (r) => {
      // `RUN exit 3` prints nothing, so docker relaying its exit status is the only
      // account of the failure there is. BuildKit tags a step's own output with that
      // step's number and elapsed time, and this step has no such line - which is how
      // this case is told apart from docker_buildkit_pytest_fail, where the step
      // printed plenty and pytest owns the log.
      assert.equal(r.failures[0].file, "Dockerfile.run");
      assert.equal(r.failures[0].line, 2);
      assert.equal(r.failures[0].stmt, "RUN exit 3");
      assert.match(r.failures[0].message, /did not complete successfully: exit code: 3/);
      // The fallback scraped the step's ERROR and the one restating it at the end.
      assert.equal(r.failures.length, 1, "one failure, not docker saying it twice");
    } },
  { file: "docker_copy_fail.txt", tool: "docker", n: 1, check: (r) => {
      assert.equal(r.failures[0].line, 2);
      assert.equal(r.failures[0].stmt, "COPY missing-file.txt /tmp/");
      assert.match(r.failures[0].message, /"\/missing-file\.txt": not found/);
    } },
  // Captured on a windows-latest runner with Go 1.22, by running the failures there and
  // taking what Go printed - the runner's own timestamps and ##[error] tags are the log
  // viewer's, not Go's, and are not part of these files. Every other fixture in this
  // suite has unix paths, so nothing exercised the separator Go actually uses on the
  // platform the test matrix has been running on all along.
  { file: "go_windows_build_fail.txt", tool: "go build", n: 4, check: (r) => {
      // `pkg\helper.go` and `.\main.go` - a class written [\w./-] matches neither, so
      // this whole log used to fall through to the generic fallback.
      assert.equal(r.failures[0].file, "pkg\\helper.go");
      assert.equal(r.failures[0].line, 4);
      // `.\` is the same "this directory" prefix as `./` and is dropped the same way.
      assert.equal(r.failures[1].file, "main.go");
      assert.deepEqual(r.failures.map((f) => f.line), [4, 6, 6, 7]);
    } },
  { file: "go_windows_vet_fail.txt", tool: "go vet", n: 2, check: (r) => {
      // Windows spells the prefix `vet.exe: `. Without it both locations were lost and
      // the run came back as one unlocated guess.
      assert.deepEqual(r.failures.map((f) => f.file), ["pkg\\helper.go", "main.go"]);
      assert.doesNotMatch(JSON.stringify(r.failures), /vet\.exe/);
    } },
  { file: "go_windows_test_fail.txt", tool: "go test", n: 2, check: (r) => {
      // go test needed no fixing, and this pins why: the testing package prints a bare
      // basename, and the runtime writes its frames with forward slashes even here.
      assert.equal(r.failures[0].file, "shop_test.go");
      assert.match(r.failures[1].file, /^D:\/a\/.*shop_test\.go$/);
      // The panic unwinds through testing.go and panic.go under a Windows toolchain
      // path; those are Go's frames, not yours.
      assert.doesNotMatch(JSON.stringify(r.failures.map((f) => f.file)), /hostedtoolcache/);
    } },
  // Captured by running pylint and biome against a directory called "my project" -
  // ordinary on macOS and Windows, and something no fixture here had. Both parsers
  // described the filename as (\S+?), so both produced nothing at all.
  { file: "pylint_spaced_path_fail.txt", tool: "pylint", n: 1, check: (r) => {
      assert.equal(r.failures[0].file, "my project/mod.py");
      assert.equal(r.failures[0].line, 4);
      assert.equal(r.failures[0].code, "E0602");
      // What bounds the name is the message code after it, not the name's own shape.
      assert.match(r.summary, /4 advisory hidden/);
    } },
  { file: "biome_spaced_path_fail.txt", tool: "biome", n: 1, check: (r) => {
      assert.equal(r.failures[0].file, "my project/src/app.js");
      assert.equal(r.failures[0].code, "parse");
    } },
  { file: "biome_format_fail.txt", tool: "biome", n: 1, check: (r) => {
      // `biome format` heads its finding with the file and no line at all, so this whole
      // shape was invisible: the only failure in the run, and the run came back silent.
      assert.equal(r.failures[0].file, "my project/src/fmt.js");
      assert.equal(r.failures[0].line, undefined, "biome printed no line; none is invented");
      assert.equal(r.failures[0].code, "format");
      assert.match(r.failures[0].message, /Formatter would have printed/);
      // The closing banner is the command's own name - `format ━━━` - and is not a file.
      assert.equal(r.failures.length, 1);
    } },
  // Captured with rubocop 1.91 and golangci-lint on Debian - the two linters a Ruby and
  // a Go CI job most often fail on. rubocop had no parser at all; golangci-lint was
  // being read by go's, which called its findings "compile errors" from `go build`.
  { file: "rubocop_fail.txt", tool: "rubocop", n: 13, check: (r) => {
      assert.equal(r.failures[0].file, "app.rb");
      assert.equal(r.failures[0].col, 1, "the fallback dropped the column");
      assert.equal(r.failures[0].code, "Style/FrozenStringLiteralComment");
      // "[Correctable]" is rubocop saying -a would fix it, not part of what is wrong.
      assert.doesNotMatch(JSON.stringify(r.failures), /Correctable/);
      assert.equal(r.failures[0].stmt, "def calculate( x )");
      // rubocop's own tally for this run is "13 offenses detected".
      assert.equal(r.summary, "13 problems");
    } },
  { file: "rubocop_syntax_fail.txt", tool: "rubocop", n: 1, check: (r) => {
      assert.equal(r.failures[0].code, "Lint/Syntax");
      assert.equal(r.failures[0].line, 2);
      // The line under this offence is a note about the parser version, not the source.
      // Only a caret line says the line above it is source, and there is none here.
      assert.equal(r.failures[0].stmt, undefined, "a note about the parser is not the offending line");
    } },
  { file: "golangci_fail.txt", tool: "golangci-lint", n: 6, check: (r) => {
      // The linter's name is what you would disable, so it is the code rather than
      // being left inside the message where nothing can group on it.
      assert.deepEqual(r.failures.map((f) => f.code),
        ["errcheck", "ineffassign", "revive", "revive", "revive", "revive"]);
      assert.equal(r.failures[0].col, 15);
      assert.doesNotMatch(r.failures[0].message, /\(errcheck\)/);
      assert.equal(r.failures[0].stmt, "defer f.Close()");
    } },
  { file: "golangci_typecheck_fail.txt", tool: "golangci-lint", n: 1, check: (r) => {
      // When the package will not compile, golangci-lint prints go's own diagnostics and
      // tags only the LAST of them "(typecheck)". The other two are go's line for line,
      // so go's parser reads them and they arrive attributed rather than lost.
      assert.equal(r.failures[0].code, "typecheck");
      assert.equal(r.failures[0].line, 7);
      const others = (r.others ?? []).flatMap((o) => o.failures);
      assert.equal(others.length, 2, "the two untagged compile errors are still reported");
      assert.equal((r.others ?? [])[0].tool, "go build");
    } },
  // Captured from `make -j2` with two failing compilations, on macOS. Two compilers
  // writing into one pipe interleaved mid-line, and b.c's diagnostic came out with a
  // fragment of a.c's source frame driven through the middle of it:
  //
  //   b.c:1    1 | :21: error: use of undeclared identifier 'alsonope'
  //
  // That line is not recoverable without guessing which bytes are foreign, and nothing
  // here tries. The count is the part of the wreckage that survived: clang writes
  // "1 error generated." once per translation unit, twice here, and every undamaged log
  // in this corpus agrees with that number exactly.
  { file: "make_parallel_shredded_fail.txt", tool: "clang", n: 1, check: (r) => {
      assert.equal(r.failures[0].file, "a.c");
      assert.equal(r.failures[0].line, 1);
      assert.match(r.failures[0].message, /undeclared identifier 'nope'/);
      // The one that matters: the headline does not claim this was the only one.
      assert.equal(r.summary, "1 of the 2 errors clang reported");
      // and the shredded line is not half-read into a failure of its own
      assert.doesNotMatch(JSON.stringify(r.failures), /alsonope/);
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
  // `eslint -f json` is what a pipeline uses when something downstream reads the result,
  // and it produced nothing at all. eslint's json formatter writes the whole document on
  // one line, which is what makes it findable inside a bigger log - the runner fixture
  // is a real `bunx eslint` run, banner and all, and that banner alone was enough to
  // defeat parsing the log as a document.
  { file: "eslint_json_fail.txt", tool: "eslint", n: 6, check: (r) => {
      assert.deepEqual(r.failures.map((f) => f.code),
        ["eqeqeq", "no-undef", "no-undef", "no-unused-vars", "no-unused-vars", "no-undef"]);
      assert.deepEqual(r.failures.map((f) => [f.line, f.col]),
        [[2, 7], [2, 15], [2, 27], [3, 5], [1, 19], [1, 31]]);
      // eslint's own headline, in eslint's own words.
      assert.equal(r.summary, "6 problems (6 errors, 0 warnings)");
    } },
  { file: "eslint_text_same_fail.txt", tool: "eslint", n: 6, check: (r) => {
      assert.equal(r.summary, "6 problems (6 errors, 0 warnings)");
    } },
  { file: "eslint_json_runner_fail.txt", tool: "eslint", n: 6, check: (r) => {
      // Same six, under three lines of bun's own chatter.
      assert.equal(r.failures.length, 6);
      assert.doesNotMatch(JSON.stringify(r.failures), /Resolving dependencies|Saved lockfile/);
    } },
  { file: "eslint_json_parse_fail.txt", tool: "eslint", n: 1, check: (r) => {
      // A file eslint could not parse carries no rule, because no rule ran.
      assert.equal(r.failures[0].code, undefined);
      assert.equal(r.failures[0].label, "parse error");
      assert.match(r.failures[0].message, /Parsing error: Unexpected token/);
    } },
  // One run of a Go project, captured plainly and with -v. Verbose output puts a test's
  // lines ABOVE its "--- FAIL" line, frames parallel tests with PAUSE/CONT and switches
  // between them with "=== NAME" - and every failure in a verbose log used to be pinned
  // to the NEXT test's output: TestAdd reported with TestTable/zero's error, and
  // TestTable/zero with TestParallelA's, a passing test's log included.
  { file: "gotest_verbose_fail.txt", tool: "go test", n: 4, check: (r) => {
      assert.deepEqual(r.failures.map((f) => [f.title, f.line]),
        [["TestAdd", 7], ["TestTable/zero", 22], ["TestParallelA", 30], ["TestNilMap", 7]]);
      // TestParallelB passed. Its log line sits between A's two and must not join them.
      assert.doesNotMatch(JSON.stringify(r.failures), /B says hello/);
      // TestTable's own "--- FAIL" carries nothing of its own; the failure is its subtest's.
      assert.ok(!r.failures.some((f) => f.title === "TestTable"));
      // A panic's dump comes after its test's result line, and still belongs to it.
      assert.match(r.failures[3].message, /nil map/);
    } },
  { file: "gotest_verbose_plain_fail.txt", tool: "go test", n: 4, check: (r) => {
      assert.deepEqual(r.failures.map((f) => [f.title, f.line]),
        [["TestAdd", 7], ["TestTable/zero", 22], ["TestParallelA", 30], ["TestNilMap", 7]]);
    } },
  // The same Go project run a third time, under -json: the test2json stream gotestsum and
  // most Go CI keep, which came back as one guess made of raw JSON.
  { file: "gotest_json_fail.txt", tool: "go test", n: 4, check: (r) => {
      assert.deepEqual(r.failures.map((f) => [f.title, f.line]),
        [["TestAdd", 7], ["TestTable/zero", 22], ["TestParallelA", 30], ["TestNilMap", 7]]);
      assert.doesNotMatch(JSON.stringify(r.failures), /"Action"|B says hello/);
    } },
  // One `go test ./...` over a package that will not compile and another whose tests
  // fail - an ordinary invocation, not two glued together - captured plainly, with -v and
  // with -json. Plain and -v reported the compile error and dropped all three tests; -json
  // did the opposite, because go reports a build as "build-output" events.
  { file: "gotest_build_and_tests_fail.txt", tool: "go test", n: 4, check: (r) => {
      assert.deepEqual(r.failures.map((f) => [f.title, f.line]).sort(), [["compile error", 3], ["TestAdd", 7], ["TestTable/zero", 22], ["TestParallelA", 30]].sort());
      assert.equal(r.summary, "1 compile error, 3 tests failed");
    } },
  { file: "gotest_build_and_tests_verbose_fail.txt", tool: "go test", n: 4, check: (r) => {
      assert.deepEqual(r.failures.map((f) => [f.title, f.line]).sort(), [["compile error", 3], ["TestAdd", 7], ["TestTable/zero", 22], ["TestParallelA", 30]].sort());
    } },
  { file: "gotest_build_and_tests_json_fail.txt", tool: "go test", n: 4, check: (r) => {
      assert.deepEqual(r.failures.map((f) => [f.title, f.line]).sort(), [["compile error", 3], ["TestAdd", 7], ["TestTable/zero", 22], ["TestParallelA", 30]].sort());
      assert.equal(r.summary, "1 compile error, 3 tests failed");
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
  { file: "gorace_fail.txt", tool: "go test", n: 3, check: (r) => {
      // real `go test -race`. The detector names the exact line of the racing
      // access - the bug - while the assertion below it only reports a wrong total.
      // Before, the race report was dropped and the output pointed at line 17,
      // the symptom, instead of line 13, the cause.
      assert.equal(r.summary, "1 test failed, 2 data races");
      const races = r.failures.filter((f) => f.title === "DATA RACE");
      assert.equal(races.length, 2);
      assert.equal(races[0].line, 13, "the racing access, not the assertion");
      assert.match(races[0].file, /race_test\.go$/);
      // go writes "Read at" but "Previous write at" - both operations must be named
      assert.match(races[0].message, /Read by goroutine \d+/);
      assert.match(races[0].message, /Previous write by goroutine \d+/i);
      // the ordinary assertion failure is still reported, and still called a test
      const test = r.failures.find((f) => f.title === "TestRace");
      assert.ok(test && test.line === 17, "the assertion failure is still there");
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
  const matcher = JSON.parse(readFileSync(join(here, "..", ".github", "whatbroke.problem-matcher.json"), "utf8"));
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

// A log does not always arrive the way the tool wrote it. It gets redirected on Windows,
// captured from a terminal that was drawing a progress bar, pasted into a file. Every
// parser anchors on ^, so anything in front of the first line is enough to lose it.
try {
  const shapes = {
    // PowerShell writes a byte-order mark at the head of anything it redirects. 25
    // fixtures read differently with one in front of them; bun's unresolved import fell
    // all the way to the guess.
    "a PowerShell byte-order mark": (t) => "\uFEFF" + t,
    "Windows line endings": (t) => t.replace(/\n/g, "\r\n"),
    // A progress bar redraws in place with CR and no newline. Each redraw becomes its
    // own line rather than only the last one surviving: a tool that printed an error and
    // then redrew over it really did print the error, and losing it would be the one
    // thing this tool must never do.
    "a progress bar first": (t) => "\rProgress:  10%\rProgress:  90%\rProgress: 100%\n" + t,
    "no trailing newline": (t) => t.replace(/\n+$/, ""),
    "blank lines first": (t) => "\n\n\n" + t,
  };
  const changed = [];
  let checked = 0;
  for (const name of readdirSync(join(here, "fixtures"))) {
    const raw = readFileSync(join(here, "fixtures", name), "utf8");
    if (raw.includes("\r\n")) continue;
    const read = (t) => { try { const r = analyse(t); return r ? `${r.tool}/${r.failures.length}` : "none"; } catch { return "threw"; } };
    const plain = read(raw);
    for (const [what, shape] of Object.entries(shapes)) {
      checked++;
      const got = read(shape(raw));
      if (got !== plain) changed.push(`${name} with ${what}: ${plain} -> ${got}`);
    }
  }
  assert.ok(checked > 500, `only ${checked} shapes exercised`);
  assert.deepEqual(changed.slice(0, 6), [], "a log that arrived differently read differently");
  console.log(`  ok   ${checked} logs survive the ways a log actually reaches you`);
  pass++;
} catch (e) { console.log(`  FAIL log arrival shapes\n       ${e.message}`); fail++; }

// A parser may compose a message - node's "AssertionError: Expected values to be
// strictly equal:" reads better than either half alone, and black's log says only
// "would reformat x.py", which has to be explained rather than quoted. Eight parsers do,
// each deliberately and each saying so where it does it.
//
// A LOCATION is different. It is a fact, not a phrasing: whatbroke tells the reader
// which file and line to open, and a file it made up sends them nowhere. Every located
// failure in the corpus must name a file the log actually contains.
try {
  const missing = [];
  let located = 0;
  for (const name of readdirSync(join(here, "fixtures"))) {
    const raw = fx(name);
    const { stripAnsi } = await import("../src/util.js");
    const text = stripAnsi(raw);
    let r;
    try { r = analyse(raw); } catch { continue; }
    for (const f of [...(r?.failures ?? []), ...(r?.others ?? []).flatMap((o) => o.failures)]) {
      if (!f.file) continue;
      located++;
      const file = String(f.file);
      // a path may be decoded out of a file:// URL, so the basename is enough to prove
      // the parser read it rather than invented it
      const base = file.split(/[/\\]/).pop();
      if (!text.includes(file) && !text.includes(encodeURI(file)) && !(base && text.includes(base))) {
        missing.push(`${name} (${r.tool}): ${JSON.stringify(file.slice(0, 50))}`);
      }
    }
  }
  assert.ok(located > 300, `only ${located} located failures checked`);
  assert.deepEqual(missing.slice(0, 6), [], "a parser reported a file the log never names");
  console.log(`  ok   all ${located} located failures name a file the log contains`);
  pass++;
} catch (e) { console.log(`  FAIL invented locations\n       ${e.message}`); fail++; }

// A location pattern loose enough to match a sentence will read one as a filename.
// node's was `^(\S.*?):(\d+)$`, which accepts anything ending in a number - and black
// writes "error: cannot format cantparse.py: Cannot parse: 1:7" above a source line and
// a caret, which is node's exact shape. It reported a failure in a file by that name.
//
// Colons cannot be what rules it out, because node itself writes "file:///abs/x.mjs:1".
// Whitespace can: a path has none and a sentence has plenty. This feeds every parser
// bait shaped like a location and asserts none of them bites.
try {
  const BAIT = [
    "error: cannot format thing.py: Cannot parse: 1:7",
    "Something went wrong in the build at step 3:12",
    "note: expected 2 arguments but found 1:5",
  ];
  // "has a space in it" was this check for a long time, and it was a good proxy while no
  // parser would accept one. pylint and biome print `my project/mod.py` for a directory
  // called "my project", which is ordinary on macOS and Windows, so the proxy started
  // failing real filenames. What actually separates the bait from a path is not the
  // space: it is that a path has a separator and an extension, and that a label ends
  // with a colon and a space where a path never does. All three baits above still fail
  // every one of those, which is what makes this a narrowing of the rule and not of the
  // guard.
  const prose = (file) => {
    if (!file) return false;
    if (/:[^\S\n]/.test(file)) return true;            // "error: cannot format thing.py"
    if (!/\s/.test(file)) return false;                 // no space, nothing to argue about
    return !(/[\\/]/.test(file) && /\.\w{1,10}$/.test(file));
  };
  // The rule is the guard, so it is pinned too: loosening it later has to be deliberate.
  for (const sentence of ["error: cannot format thing.py", "Something went wrong at step 3",
    "expected 2 arguments but found 1", "note: bad input"]) {
    assert.equal(prose(sentence), true, `${JSON.stringify(sentence)} is prose, not a path`);
  }
  for (const path of ["my project/mod.py", "my project/src/app.js", "main.go",
    "src/app.ts", "C:\\src\\app.ts", "a b/c d/e.rs"]) {
    assert.equal(prose(path), false, `${JSON.stringify(path)} is a path a tool really prints`);
  }
  const bitten = [];
  let checked = 0;
  for (const name of readdirSync(join(here, "fixtures"))) {
    const raw = fx(name);
    for (const bait of BAIT) {
      // in front of the log, and behind it wearing node's caret shape
      for (const text of [`${bait}\n${raw}`,
        `${raw}\n${bait}\n    some source line\n          ^\nError: bad input\n`]) {
        checked++;
        let r;
        try { r = analyse(text); } catch { continue; }
        for (const f of [...(r?.failures ?? []), ...(r?.others ?? []).flatMap((o) => o.failures)]) {
          if (prose(String(f.file ?? ""))) {
            bitten.push(`${name} (${r.tool}): ${JSON.stringify(String(f.file).slice(0, 50))}`);
          }
        }
      }
    }
  }
  assert.ok(checked > 500, `only ${checked} baited logs exercised`);
  assert.deepEqual([...new Set(bitten)].slice(0, 6), [], "a parser read a sentence as a filename");
  console.log(`  ok   ${checked} baited logs, no parser reads a sentence as a filename`);
  pass++;
} catch (e) { console.log(`  FAIL sentence as filename\n       ${e.message}`); fail++; }

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

// a message that says one thing many times
try {
  const { collapseRepeats } = await import("../src/util.js");
  // A Go test with twenty-four subtests fails twenty-four times with the same assertion,
  // and the parser gathers all of them: 503 characters saying "Unexpected response."
  const r = analyse(fx("gotest_cluster_fail.txt"));
  const long = r.failures.find((f) => /Unexpected response/.test(f.message ?? ""));
  assert.ok(long, "the repeated assertion should still be reported");
  assert.equal(long.message, "Unexpected response. (x24)");
  assert.ok(long.message.length < 40, `still ${long.message.length} chars`);

  // Only consecutive runs, and only from three - saying something twice is usually the
  // tool making a point, and annotating it would be noisier than the repeat.
  assert.equal(collapseRepeats("a\nb\nb\nb\nc"), "a\nb (x3)\nc");
  assert.equal(collapseRepeats("a\nb\nb\nc"), "a\nb\nb\nc", "a run of two is left alone");
  assert.equal(collapseRepeats("e: 1\ng: 2\ne: 3\ng: 4"), "e: 1\ng: 2\ne: 3\ng: 4",
    "an alternating diagnostic keeps its shape");
  assert.equal(collapseRepeats("\n\n\n\n"), "\n\n\n\n", "blank lines are not a repeat worth counting");
  assert.equal(collapseRepeats("one line"), "one line");
  assert.equal(collapseRepeats(undefined), undefined);
  console.log("  ok   a message that repeats itself is collapsed with a count");
  pass++;
} catch (e) { console.log(`  FAIL repeated message collapse\n       ${e.message}`); fail++; }

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
    "flake8_fail.txt",           // the same whitespace rule in three places
    "swiftc_bulk_fail.txt",      // eight assignments of the same wrong type, one cause
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

// A failure says what it is. `code` is a diagnostic identifier, `subject` is the name
// of the site that failed, `label` is a constant the tool prints for a class of
// failure - and they are mutually exclusive, because clustering treats them as opposite
// things. Declaring two would mean the parser has not decided which it produced.
try {
  const tools = new Set();
  const unclassifiedBy = new Set();
  let classified = 0, total = 0;
  for (const file of readdirSync(join(here, "fixtures"))) {
    const r = analyse(fx(file));
    if (!r) continue;
    tools.add(r.tool);
    for (const f of r.failures) {
      total++;
      const declared = ["code", "subject", "label"].filter((k) => f[k]);
      assert.ok(declared.length <= 1,
        `${r.tool} declares ${declared.join(" and ")} on one failure; they are alternatives`);
      if (declared.length) classified++; else unclassifiedBy.add(r.tool);
      assert.ok(f.severity, `${r.tool} emitted a failure with no severity`);
      assert.notEqual(f.severity, "warning", `${r.tool} reported a warning as a failure`);
    }
  }
  // A ratio let a new parser quietly spend the budget: swift declared nothing for a
  // whole release and stayed inside 95%, and the cost was that eight identical errors
  // could not be grouped. The exceptions are named instead, and they are the tools that
  // genuinely print no identifier of any kind:
  //
  //   generic   a guess, by definition unidentified
  //   go        writes "./main.go:6:18: cannot use ..." with no severity word at all,
  //             so calling it "error" would be inventing one
  //
  // Anything else reaching here is a parser that has not said what it produced.
  const MAY_BE_UNCLASSIFIED = new Set(["output", "go build", "go vet", "go test"]);
  const undeclared = [...unclassifiedBy].filter((t) => !MAY_BE_UNCLASSIFIED.has(t));
  assert.deepEqual(undeclared, [],
    "a parser emitted a failure declaring neither code, subject nor label");
  assert.ok(classified / total > 0.95, `only ${classified} of ${total} failures are classified`);
  console.log(`  ok   ${classified} of ${total} failures across ${tools.size} tools declare what they are`);
  pass++;
} catch (e) { console.log(`  FAIL failure classification\n       ${e.message}`); fail++; }

// The clustering policy used to be a table keyed on 27 tool strings. It now falls out
// of what the failure declares, and these are the three behaviours that table encoded.
try {
  const { clusterFailures, keyOf } = await import("../src/cluster.js");
  const msg = "AssertionError: totals disagree";
  // a subject is the axis clustered ACROSS, so two sites with one cause group
  const sites = [1, 2, 3].map((n) => ({ subject: `test_case_${n}`, message: msg, file: "a.py", line: n }));
  assert.equal(clusterFailures(sites).filter((c) => c.reported).length, 1,
    "failures differing only in subject are one cause");
  // a code is the identity, so two codes never merge however alike the message
  const codes = [1, 2, 3, 4, 5, 6].map((n) => ({ code: n > 3 ? "E001" : "E002", message: msg, file: "a.rs", line: n }));
  assert.equal(clusterFailures(codes).filter((c) => c.reported).length, 2,
    "two diagnostic codes are two causes");
  // with a code present the echoed statement is the instance, not the identity
  const withStmt = { code: "TS2551", message: msg, stmt: "a.b()" };
  assert.equal(keyOf(withStmt), keyOf({ ...withStmt, stmt: "c.d()" }),
    "the statement must not split one diagnostic code into two causes");
  // without one it is the strongest discriminator there is, so it stays
  const noCode = { subject: "test_x", message: msg, stmt: "assert a == b" };
  assert.notEqual(keyOf(noCode), keyOf({ ...noCode, stmt: "assert c == d" }),
    "without a code the statement must still discriminate");
  console.log("  ok   clustering policy follows the failure's own fields");
  pass++;
} catch (e) { console.log(`  FAIL field-derived clustering policy\n       ${e.message}`); fail++; }

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

// Captured Node assertions have a verbose matcher header, but still carry no
// shared cause when all that remains underneath it is a numeric comparison.
try {
  const { render } = await import("../src/render.js");
  const { clusterFailures } = await import("../src/cluster.js");
  const r = analyse(fx("nodetest_nested_fail.txt"));
  assert.ok(r.clusters.every((c) => !c.reported), "matcher boilerplate must not justify grouping");
  const out = render(r, { source: false, max: Infinity });
  assert.doesNotMatch(out, /likely cause/);
  for (const comparison of ["2 !== 3", "4 !== 5", "6 !== 7"]) assert.ok(out.includes(comparison));
  // A shared expression is still useful evidence; this must not disable all
  // assertion clustering merely because the framework supplies a header.
  const withExpression = r.failures.map((f) => ({ ...f, stmt: "assert.equal(cart.total(), expected)" }));
  assert.equal(clusterFailures(withExpression, r.tool).filter((c) => c.reported).length, 1);
  console.log("  ok   Node assertion boilerplate cannot merge unrelated numeric failures");
  pass++;
} catch (e) { console.log(`  FAIL Node assertion grouping\n       ${e.message}`); fail++; }

// A truncated log can contain only the parent failure. Keep that diagnosis, and
// ensure failures in a previous, unrelated suite do not cause it to be dropped.
try {
  const raw = fx("nodetest_nested_fail.txt");
  const parent = raw.slice(raw.indexOf("\nnot ok 1 - arithmetic") + 1);
  for (const input of [parent, "# Subtest: arithmetic\n" + parent,
    fx("nodetest_fail.txt") + "\n# Subtest: arithmetic\n" + parent]) {
    const r = analyse(input);
    const kept = r.failures.filter((f) => f.title === "arithmetic");
    assert.equal(kept.length, 1, "a parent without captured children must remain visible");
    assert.equal(kept[0].message, "2 subtests failed");
  }
  // The same captured log must produce one annotation per actual failing test.
  const github = spawnSync(process.execPath, [cli, "--format", "github"], {
    input: raw, encoding: "utf8", env: { ...process.env, GITHUB_STEP_SUMMARY: "" },
  });
  assert.equal(github.status, 0);
  assert.equal((github.stdout.match(/^::error /gm) ?? []).length, 3);
  assert.doesNotMatch(github.stdout, /title=(arithmetic|first operations)/);
  const json = spawnSync(process.execPath, [cli, "--json"], { input: raw, encoding: "utf8" });
  assert.equal(json.status, 0);
  assert.equal(JSON.parse(json.stdout).failures.length, 3);
  console.log("  ok   Node parent summaries are removed only when child failures are captured");
  pass++;
} catch (e) { console.log(`  FAIL Node parent summaries\n       ${e.message}`); fail++; }

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
    // esbuild's CLI wrapper crashes after esbuild exits non-zero, so the log carries a
    // real diagnostic AND a Node stack. Both parsers match by design; esbuild is listed
    // first and wins, and the wrapper's stack is filtered out of the mixed-log path
    // because it sits entirely in node internals.
    "esbuild_syntax_fail.txt": ["esbuild", "node"],
    "esbuild_resolve_fail.txt": ["esbuild", "node"],
    // eslint reports a broken config by crashing, so the log is a Node stack. Both
    // parsers match by design; eslint is listed first and reports the config error
    // rather than a line inside eslint's own internals.
    "eslint_config_fail.txt": ["eslint", "node"],
    // a file mocha cannot load never reaches its tally, so the log is mocha's own line
    // over a Node stack. Both parsers match by design; mocha is listed first and reports
    // the file that would not load rather than a frame inside the module loader.
    "mocha_load_fail.txt": ["mocha", "node"],
    // swc ends a failed compile with "Error: Failed to compile 1 file with swc.", which
    // node reads as its own. Both parsers match by design; swc is listed first and
    // reports the diagnostic miette drew above that line rather than the tally itself.
    "swc_fail.txt": ["swc", "node"],
    // golangci-lint's findings and `go build`'s diagnostics are the same shape, which is
    // why go's parser was reading a lint run as six compile errors. A pure lint log is no
    // longer contested at all: go skips the lines that name a linter in brackets, because
    // it never writes one itself. This fixture is here because go really did produce two
    // of its lines - when the package will not compile, golangci-lint prints go's
    // diagnostics verbatim and tags only the last of them "(typecheck)". Both parsers are
    // right about their own half.
    "golangci_typecheck_fail.txt": ["golangci-lint", "go"],
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
  console.log(`  ok   ${Object.keys(KNOWN).length} fixtures are decided by parser order, all expected`);
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

// CI kills a hanging suite, a byte cap trips, a pipe is closed - logs arrive cut
// off mid-block, and that must never throw or corrupt the partition
try {
  const { render, setColor } = await import("../src/render.js");
  setColor(false);
  let checked = 0;
  for (const file of readdirSync(join(here, "fixtures"))) {
    const raw = fx(file);
    const lines = raw.split("\n");
    for (const frac of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      const cut = lines.slice(0, Math.max(1, Math.floor(lines.length * frac))).join("\n");
      checked++;
      const r = analyse(cut);
      if (!r) continue;
      render(r, {});
      const members = r.clusters.flatMap((c) => c.members).sort((a, b) => a - b);
      assert.deepEqual(members, [...r.failures.keys()], `${file} cut at ${frac} broke the partition`);
    }
    // and cut mid-line, the way a byte cap does
    analyse(raw.slice(0, Math.floor(raw.length * 0.6)));
  }
  console.log(`  ok   ${checked} truncated logs parse without throwing or losing a failure`);
  pass++;
} catch (e) { console.log(`  FAIL truncated input\n       ${e.message}`); fail++; }

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

// The step summary is what a human reads in CI, so it leads with causes like the
// terminal does - while the annotations below it stay one per failure, because each
// one is a marker on a line and dropping one hides a line.
try {
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "whatbroke-cluster-summary-"));
  const summary = join(dir, "summary.md");
  const raw = fx("eslint_bulk_fail.txt");
  const r = spawnSync(process.execPath, [cli, "--format", "github"], {
    input: raw, encoding: "utf8", env: { ...process.env, GITHUB_STEP_SUMMARY: summary },
  });
  const md = readFileSync(summary, "utf8");
  const analysed = analyse(raw);
  const causes = analysed.clusters.filter((c) => c.reported);
  assert.ok(causes.length >= 2, "fixture must actually cluster for this test to mean anything");
  assert.match(md, new RegExp(`\\*\\*${causes.length} likely causes, \\d+ sites`),
    "summary must lead with the cause count");
  assert.match(md, /^### 1\. /m, "each cause gets its own section");
  assert.match(md, /<details><summary>\d+ (?:case|site)s<\/summary>/, "sites are folded, not listed flat");
  // nothing is hidden: every failure still reaches the summary and the annotations
  for (const f of analysed.failures) assert.ok(md.includes(`${f.file}:${f.line}`), `${f.file}:${f.line} missing`);
  assert.equal((r.stdout.match(/^::error /gm) ?? []).length, analysed.failures.length);
  assert.match(r.stdout, /^::notice title=whatbroke::.* likely causes, \d+ sites$/m);
  rmSync(dir, { recursive: true, force: true });
  console.log("  ok   GitHub summary leads with clusters and hides nothing");
  pass++;
} catch (e) { console.log(`  FAIL GitHub clustered summary\n       ${e.message}`); fail++; }

// A disclosure that says "6 sites" over a list of three is the tool contradicting its
// own evidence, which is the one thing clustering must never do. Members and distinct
// places diverge whenever parametrized cases share a source line.
try {
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "whatbroke-labels-"));
  let checked = 0;
  for (const name of readdirSync(join(here, "fixtures"))) {
    const summary = join(dir, `${name}.md`);
    spawnSync(process.execPath, [cli, "--format", "github"], {
      input: fx(name), encoding: "utf8", env: { ...process.env, GITHUB_STEP_SUMMARY: summary },
    });
    const md = readFileSync(summary, "utf8");
    for (const [, label, body] of md.matchAll(/<details><summary>(.*?)<\/summary>\n(.*?)<\/details>/gs)) {
      const listed = body.split("\n").filter((l) => l.startsWith("- ")).length;
      const claimed = Number((label.match(/\d+/g) ?? []).at(-1));
      assert.equal(claimed, listed, `"${label}" in ${name} sits above ${listed} entries`);
      checked++;
    }
  }
  assert.ok(checked > 5, "the corpus must actually produce disclosures for this to test anything");
  rmSync(dir, { recursive: true, force: true });
  console.log(`  ok   every GitHub summary disclosure counts what it lists (${checked} checked)`);
  pass++;
} catch (e) { console.log(`  FAIL GitHub summary disclosure counts\n       ${e.message}`); fail++; }

// A workflow command unescapes only %25/%0D/%0A in a message body, so escaping a
// colon there leaves "KeyError%3A 'exp'" on screen. Property values still need it.
try {
  const r = spawnSync(process.execPath, [cli, "--format", "github"], {
    input: fx("pytest_fail.txt"), encoding: "utf8",
    env: { ...process.env, GITHUB_STEP_SUMMARY: "" },
  });
  const errors = r.stdout.match(/^::error .*$/gm) ?? [];
  assert.ok(errors.some((l) => l.endsWith("::KeyError: 'exp'")), "message colons stay literal");
  for (const line of errors) {
    const [props, ...rest] = line.slice("::error ".length).split("::");
    assert.doesNotMatch(rest.join("::"), /%3A|%2C/, "message must not carry property escapes");
    // a raw comma or colon inside a value would be read as the next property, or as
    // the end of the property block - so those two stay escaped here
    for (const prop of props.split(",")) {
      assert.doesNotMatch(prop.slice(prop.indexOf("=") + 1), /[:,]/, "property values must stay escaped");
    }
  }
  console.log("  ok   annotation messages keep colons that property values escape");
  pass++;
} catch (e) { console.log(`  FAIL annotation escaping\n       ${e.message}`); fail++; }

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
  assert.match(r.stdout, /│ null\.x/, "statements captured in the log must remain visible");
  console.log("  ok   no-source mode avoids reading source context");
  pass++;
} catch (e) { console.log(`  FAIL no-source mode\n       ${e.message}`); fail++; }

try {
  const { render } = await import("../src/render.js");
  const fs = (await import("node:fs")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const originalRead = fs.readFileSync;
  let reads = 0, out;
  try {
    fs.readFileSync = (...args) => { reads++; return originalRead(...args); };
    syncBuiltinESMExports();
    out = render({ failures: [{ file: cli, line: 1, message: "bad", stmt: "total = value" }] }, { source: false });
  } finally {
    fs.readFileSync = originalRead;
    syncBuiltinESMExports();
  }
  assert.equal(reads, 0, "--no-source must not read files for snippets or stale-source checks");
  assert.match(out, /total = value/);
  console.log("  ok   no-source renders captured statements without any source reads");
  pass++;
} catch (e) { console.log(`  FAIL no-source read isolation\n       ${e.message}`); fail++; }

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
  // Each line is a complete captured diagnostic: routing must work when a
  // truncated log lacks both the tool banner and the final summary.
  for (const fixture of ["mypy_no_summary_fail.txt", "mypy_columns_fail.txt"]) {
    for (const line of fx(fixture).trim().split("\n")) {
      assert.equal(analyse(line).tool, "mypy");
      assert.equal(analyse("C:\\project\\" + line).tool, "mypy");
    }
  }
  assert.equal(analyse(fx("javac_fail.txt")).tool, "jvm");
  assert.equal(analyse(fx("clang_fail.txt")).tool, "clang");
  console.log("  ok   isolated Python source and stub diagnostics retain routing with optional columns");
  pass++;
} catch (e) { console.log(`  FAIL Python diagnostic routing\n       ${e.message}`); fail++; }

try {
  const raw = fx("dotnet_fail.txt");
  const withoutBanner = raw.slice(raw.indexOf("/home/dev/cs/app/Program.cs"));
  const full = analyse(raw), partial = analyse(withoutBanner);
  assert.equal(partial.tool, "dotnet");
  assert.deepEqual(partial.failures, full.failures);
  assert.equal(partial.summary, full.summary);
  // A single diagnostic needs neither a restore banner nor "Build FAILED".
  const single = analyse(withoutBanner.split("\n")[0]);
  assert.equal(single.tool, "dotnet");
  assert.deepEqual(single.failures, full.failures.slice(0, 1));
  assert.equal(analyse(fx("tsc_plain.txt")).tool, "tsc");
  console.log("  ok   .NET diagnostics need no restore banner and do not claim TypeScript");
  pass++;
} catch (e) { console.log(`  FAIL banner-free .NET detection\n       ${e.message}`); fail++; }

try {
  const r = spawnSync(process.execPath, [cli, "--json", process.execPath, "-e",
    "process.kill(process.pid, 'SIGKILL')"], { encoding: "utf8" });
  const expected = process.platform === "win32" ? 1 : 137;
  assert.equal(r.status, expected);
  assert.equal(JSON.parse(r.stdout).exitCode, expected);
  console.log("  ok   SIGKILL preserves the platform's shell-compatible exit code");
  pass++;
} catch (e) { console.log(`  FAIL SIGKILL exit code\n       ${e.message}`); fail++; }

try {
  const r = spawnSync(process.execPath, [cli, "--version"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+$/);
  console.log("  ok   version flag reports the package version");
  pass++;
} catch (e) { console.log(`  FAIL version flag\n       ${e.message}`); fail++; }

// gcc writes a missing header as `inc.c:1:10: fatal error: nope.h: No such file or
// directory`, and with -fno-show-column the column goes away - leaving exactly the shape
// make uses for an include it cannot find. make claimed it, and because make's parse
// succeeded where clang's did not, make WON: a C compile error reported as a make failure
// whose subject was "fatal error: nope.h". What tells them apart is that make puts a bare
// filename where gcc puts a severity word, so the middle has to be matched as a name.
try {
  const { EXTRACTORS } = await import("../src/index.js");
  const gcc = [
    'inc.c:1: fatal error: nope.h: No such file or directory',
    '    1 | #include "nope.h"',
    '      |          ^~~~~~~~',
    'compilation terminated.',
  ].join("\n");
  const make = EXTRACTORS.find((ex) => ex.name === "make");
  assert.equal(make.detect(gcc), false, "make claimed a compiler's diagnostic");
  assert.equal(make.extract(gcc), null);
  assert.notEqual(analyse(gcc).tool, "make");
  console.log("  ok   a compiler's missing header is not read as make's missing include");
  pass++;
} catch (e) { console.log(`  FAIL compiler header vs make include\n       ${e.message}`); fail++; }

// The same log arrives dressed differently depending on where it ran. Every fixture in
// this suite was captured on a unix terminal with colour off, and the two things that
// change on the way to a CI log - carriage returns and SGR escapes - change no byte that
// carries meaning. Both checks are cheap and both failure modes are silent, which is the
// case for pinning them rather than assuming.
try {
  const files = readdirSync(join(here, "fixtures"));
  const shape = (r) => (r ? JSON.stringify({ tool: r.tool, n: r.failures.length,
    at: r.failures.map((f) => [f.file, f.line, f.col]) }) : "null");
  const differ = [];
  for (const file of files) {
    const lf = fx(file);
    if (lf.includes("\r")) continue;
    const crlf = lf.replace(/\n/g, "\r\n");
    if (shape(analyse(lf)) !== shape(analyse(crlf))) differ.push(file);
  }
  assert.deepEqual(differ, [], "a windows line ending changed what was read");
  console.log(`  ok   a carriage return before every newline changes nothing (${files.length} fixtures)`);
  pass++;
} catch (e) { console.log(`  FAIL CRLF\n       ${e.message}`); fail++; }

try {
  const ESC = String.fromCharCode(27);
  // Three shapes real tools emit: the whole line coloured, the severity word coloured,
  // and the location coloured - the last is the one that would hide a `file:line:` from
  // a pattern anchored on ^.
  const dressed = {
    whole: (l) => (l.trim() ? `${ESC}[31m${l}${ESC}[0m` : l),
    word: (l) => l.replace(/\b(error|warning|FAIL|failed|note)\b/gi, (m) => `${ESC}[1;31m${m}${ESC}[0m`),
    location: (l) => l.replace(/^(\S+:\d+(?::\d+)?:)/, (m) => `${ESC}[36m${m}${ESC}[0m`),
  };
  const shape = (r) => (r ? JSON.stringify({ tool: r.tool, n: r.failures.length,
    at: r.failures.map((f) => [f.file, f.line, f.col]) }) : "null");
  const differ = [];
  let checked = 0;
  for (const file of readdirSync(join(here, "fixtures"))) {
    const plain = fx(file);
    if (plain.includes(ESC)) continue;
    checked++;
    const base = shape(analyse(plain));
    for (const [name, dress] of Object.entries(dressed)) {
      const coloured = plain.split("\n").map(dress).join("\n");
      if (shape(analyse(coloured)) !== base) differ.push(`${file} (${name})`);
    }
  }
  assert.deepEqual(differ, [], "colour changed what was read");
  console.log(`  ok   colour changes nothing about what was read (${checked} fixtures, 3 ways)`);
  pass++;
} catch (e) { console.log(`  FAIL ANSI\n       ${e.message}`); fail++; }

// go's parser found compile errors and returned, so a stream holding both compile errors
// and a panic reported only the compile errors and dropped the panic without a word.
// `go build ./... ; ./prog` produces exactly that, and so does golangci-lint when the
// package will not compile. Neither of the two sweeps caught it: the cross-parser one
// skips pairs read by one parser, and the same-tool one groups by the tool STRING, where
// these two logs are "go build" and "go".
try {
  const build = fx("gobuild_fail.txt"), panic = fx("gopanic_fail.txt");
  const alone = [analyse(build), analyse(panic)];
  assert.deepEqual(alone.map((r) => r.failures.length), [3, 1]);
  for (const joined of [`${build}\n${panic}`, `${panic}\n${build}`]) {
    const r = analyse(joined);
    assert.equal(r.failures.length, 4, "the panic went missing beside the compile errors");
    assert.equal(r.failures.filter((f) => f.label === "panic").length, 1);
    // and the headline counts it, rather than saying 3 over four failures
    assert.match(r.summary, /and a panic/);
  }
  console.log("  ok   a panic beside compile errors is not dropped by either of them");
  pass++;
} catch (e) { console.log(`  FAIL panic beside compile errors\n       ${e.message}`); fail++; }

// clang's own count is a claim whatbroke can be checked against, so it is. Every log
// where the two agree must keep agreeing, and any log where they do not must say so in
// the headline rather than quietly reporting the smaller number. The disagreement only
// happens on a log something has damaged - `make -j` interleaving two compilers - and
// that is exactly when a confident count is worst.
try {
  let checked = 0;
  for (const file of readdirSync(join(here, "fixtures"))) {
    const raw = fx(file);
    const declared = [...raw.matchAll(/^(\d+) errors? generated\.$/gm)]
      .reduce((n, m) => n + Number(m[1]), 0);
    if (!declared) continue;
    const r = analyse(raw);
    if (r?.tool !== "clang") continue;
    checked++;
    if (r.failures.length === declared) continue;
    assert.ok(r.failures.length < declared,
      `${file}: ${r.failures.length} failures over a log clang says had ${declared}`);
    assert.ok(r.summary.includes(String(declared)),
      `${file}: read ${r.failures.length} of ${declared} and the headline does not say so`);
  }
  assert.ok(checked >= 4, `only ${checked} logs carry a clang count`);
  console.log(`  ok   clang's own error count is never quietly contradicted (${checked} logs)`);
  pass++;
} catch (e) { console.log(`  FAIL clang count\n       ${e.message}`); fail++; }

// A machine format is only worth reading if it says the same thing as the human one.
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
  for (const [i, f] of json.failures.entries()) {
    const label = f.message.split("\n").slice(1).join("\n");
    assert.ok(label && plain.failures[i].message.endsWith(label),
      `failure ${i}: the label differs between the two formats`);
  }
  console.log("  ok   --message-format=json says what the text cargo printed says");
  pass++;
} catch (e) { console.log(`  FAIL cargo json vs text\n       ${e.message}`); fail++; }

// The same eslint run captured both ways. As with cargo, the machine format is only
// worth reading if it says the same thing as the human one - and here it can be held to
// the stricter test, because eslint's stylish output is a table of the same fields
// rather than a drawing. Only the trailing full stop differs: the text formatter strips
// it, and this does not put it back or take it off to make them match.
try {
  const json = analyse(fx("eslint_json_fail.txt"));
  const text = analyse(fx("eslint_text_same_fail.txt"));
  const facts = (r) => r.failures.map((f) => [f.file, f.line, f.col, f.code, f.severity]);
  assert.equal(json.tool, text.tool);
  assert.equal(json.summary, text.summary);
  assert.deepEqual(facts(json), facts(text),
    "the JSON report and the table eslint printed disagree about what failed");
  for (const [i, f] of json.failures.entries()) {
    assert.equal(f.message.replace(/\.$/, ""), text.failures[i].message.replace(/\.$/, ""),
      `failure ${i}: the two formats word it differently`);
  }
  console.log("  ok   eslint -f json says what the table eslint printed says");
  pass++;
} catch (e) { console.log(`  FAIL eslint json vs table\n       ${e.message}`); fail++; }

// The same Go run captured plainly and with -v has to say the same thing - file, line,
// test and message for every failure. Verbose mode is where a test's output sits above
// its result line, and it is also what every `go test -json` stream runs underneath, so
// this is the check that attribution in that layout is right rather than just different.
try {
  const plain = analyse(fx("gotest_verbose_plain_fail.txt"));
  const verbose = analyse(fx("gotest_verbose_fail.txt"));
  const facts = (r) => r.failures.map((f) => [f.file, f.line, f.title, f.message]);
  assert.deepEqual(facts(verbose), facts(plain), "-v reads a different set of failures from the same run");
  console.log("  ok   go test -v says what plain go test says");
  pass++;
} catch (e) { console.log(`  FAIL go -v vs plain\n       ${e.message}`); fail++; }

// -json is the third encoding of the same run, and has to say the same thing as the
// plain one: file, line, test and message for every failure. The stream is rebuilt into
// the verbose log inside the parser, so this is also the check that the rebuild is exact.
try {
  const plain = analyse(fx("gotest_verbose_plain_fail.txt"));
  const json = analyse(fx("gotest_json_fail.txt"));
  const facts = (r) => r.failures.map((f) => [f.file, f.line, f.title, f.message]);
  assert.deepEqual(facts(json), facts(plain), "-json reads a different set of failures from the same run");
  console.log("  ok   go test -json says what plain go test says");
  pass++;
} catch (e) { console.log(`  FAIL go -json vs plain\n       ${e.message}`); fail++; }

// The same build-and-test run in three encodings has to report the same failures. The
// comparison is of the SET: `go test ./...` runs packages in parallel, so the order their
// output arrives in is not something one run promises another.
try {
  const facts = (r) => r.failures.map((f) => JSON.stringify([f.file, f.line, f.title, f.message])).sort();
  const plain = facts(analyse(fx("gotest_build_and_tests_fail.txt")));
  for (const other of ["gotest_build_and_tests_verbose_fail.txt", "gotest_build_and_tests_json_fail.txt"]) {
    assert.deepEqual(facts(analyse(fx(other))), plain, `${other} reads a different set of failures`);
  }
  console.log("  ok   a package that will not build does not hide the tests that failed, in any encoding");
  pass++;
} catch (e) { console.log(`  FAIL build and tests\n       ${e.message}`); fail++; }

const cliResults = await (await import("./cli.js")).runCliTests();
pass += cliResults.pass;
fail += cliResults.fail;

// every fixture must be covered
const files = readdirSync(join(here, "fixtures"));
const uncovered = files.filter((f) => !CASES.some((c) => c.file === f));
if (uncovered.length) console.log(`  note: uncovered fixtures: ${uncovered.join(", ")}`);

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
