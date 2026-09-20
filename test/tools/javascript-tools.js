// JavaScript tooling: eslint, tsc, biome, oxlint, prettier, stylelint, markdownlint, sass, less, webpack, babel, swc, esbuild, vite, deno lint, fmt and check, npm, pnpm, yarn.
//
// Each case is a real capture in test/fixtures/, read the way whatbroke reads it; each
// format group is one run captured in several formats, which have to agree. The checks
// below them are about how this family's tools print what they print.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { analyse } from "../../src/index.js";
import markdownlint from "../../src/extractors/markdownlint.js";
import { createReport } from "../../src/report.js";
import { agreeAcrossFormats, cli, fx, here, runCases } from "./harness.js";

const CASES = [
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
      // the frame's bracket says 1:1, where the frame starts; the caret is the error's column
      assert.equal(r.failures[0].col, 11);
      assert.equal(r.failures[0].message, "Expression expected");
      assert.equal(r.failures[0].stmt, "const x = ;");
      assert.doesNotMatch(JSON.stringify(r), /Failed to compile/);
    } },
  // Captured with @babel/cli 7. Babel names the file inside its message and follows the
  // code frame with its own parser's stack - twenty frames of @babel/parser.
  { file: "babel_fail.txt", tool: "babel", n: 1, check: (r) => {
      assert.match(r.failures[0].file, /bad\.jsx$/);
      assert.equal(r.failures[0].line, 1);
      // `(1:10)`, counted from 0: babel's caret is under the semicolon, the 11th character
      assert.equal(r.failures[0].col, 11);
      assert.equal(r.failures[0].stmt.indexOf(";") + 1, r.failures[0].col);
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
  // Captured with Dart Sass 1.104.0. sass_fail.txt's run again with --no-unicode, which
  // draws the box in ASCII - `,` above it, `|` down it, `'` under it - and every run in that
  // mode read as a guess with no location. The two are compared as formats of one run.
  { file: "sass_ascii_fail.txt", tool: "sass", n: 1, check: (r) => {
      assert.deepEqual([r.failures[0].file, r.failures[0].line, r.failures[0].col], ["bad.scss", 2, 10]);
      assert.equal(r.failures[0].stmt, "color: $undefined-var;");
      assert.equal(r.guessed, undefined);
    } },
  // A module loop draws both loads, each under a heading naming its file, where the box
  // usually opens with its cap - so nothing under the message looked like sass's box, and the
  // loop was a guess. The trace's last frame, `root stylesheet`, is in every sass trace.
  { file: "sass_module_loop_fail.txt", tool: "sass", n: 1, check: (r) => {
      assert.deepEqual([r.failures[0].file, r.failures[0].line, r.failures[0].col], ["cross/_b.scss", 1, 1]);
      assert.equal(r.failures[0].message, "Module loop: this module is already being loaded.");
      assert.equal(r.failures[0].stmt, '@use "a";');
    } },
  { file: "sass_module_loop_ascii_fail.txt", tool: "sass", n: 1, check: (r) => {
      assert.deepEqual([r.failures[0].file, r.failures[0].line, r.failures[0].col], ["cross/_b.scss", 1, 1]);
      assert.equal(r.failures[0].message, "Module loop: this module is already being loaded.");
    } },
  // An error about two lines draws both and marks the one it is about with ^^^ - the other
  // with ━━━, or === in ASCII. The quoted line was the first in the box, which here is the
  // first load and not the one that failed.
  { file: "sass_configured_twice_fail.txt", tool: "sass", n: 1, check: (r) => {
      assert.deepEqual([r.failures[0].line, r.failures[0].col], [2, 1]);
      assert.equal(r.failures[0].stmt, '@use "lib" with ($a: 2);');
    } },
  { file: "sass_forward_conflict_ascii_fail.txt", tool: "sass", n: 1, check: (r) => {
      assert.deepEqual([r.failures[0].file, r.failures[0].line], ["cross/_both.scss", 2]);
      assert.equal(r.failures[0].message, "Two forwarded modules both define a variable named $x.");
      assert.equal(r.failures[0].stmt, '@forward "v2";');
    } },
  // A deprecation made fatal says why it is an error, and where to read about it, before it
  // draws the box - more lines than the box was looked for under the message. The import
  // deprecation above it is only a warning, and is counted as one.
  { file: "sass_fatal_deprecation_fail.txt", tool: "sass", n: 1, check: (r) => {
      assert.deepEqual([r.failures[0].file, r.failures[0].line, r.failures[0].col], ["warns.scss", 3, 10]);
      assert.equal(r.failures[0].message, "Global built-in functions are deprecated and will be removed in Dart Sass 3.0.0.");
      assert.equal(r.failures[0].stmt, "color: lighten(red, 10%);");
      assert.equal(r.summary, "1 error — 1 warning hidden");
    } },
  // Warnings were never counted: a deprecation warning's box is under its explanation, and
  // an @warn draws no box at all.
  { file: "sass_warnings_ascii_fail.txt", tool: "sass", n: 1, check: (r) => {
      assert.deepEqual([r.failures[0].file, r.failures[0].line], ["warns.scss", 4]);
      assert.equal(r.summary, "1 error — 3 warnings hidden");
      assert.doesNotMatch(JSON.stringify(r.failures), /deprecated/);
    } },
  { file: "sass_user_warn_fail.txt", tool: "sass", n: 1, check: (r) => {
      assert.deepEqual([r.failures[0].file, r.failures[0].line, r.failures[0].col], ["userwarn.scss", 3, 13]);
      assert.equal(r.summary, "1 error — 1 warning hidden");
      assert.doesNotMatch(JSON.stringify(r.failures), /careful/);
    } },
  // Captured with webpack 5. Each error is followed by the resolver's entire search -
  // forty lines of how webpack looked rather than what went wrong.
  { file: "webpack_resolve_fail.txt", tool: "webpack", n: 1, check: (r) => {
      assert.equal(r.failures[0].file, "./wsrc/index.js");
      assert.equal(r.failures[0].line, 1);
      // webpack's `1:0-36` counts from 0
      assert.equal(r.failures[0].col, 1);
      assert.match(r.failures[0].message, /^Module not found: Can't resolve '\.\/missing\.js'/);
      // "Module not found: Error: Can't resolve" says the same thing twice
      assert.doesNotMatch(r.failures[0].message, /Error:/);
      // none of the resolver's diary reaches the reader
      assert.doesNotMatch(JSON.stringify(r.failures), /description file|alias configuration/);
    } },
  { file: "webpack_parse_fail.txt", tool: "webpack", n: 1, check: (r) => {
      assert.match(r.failures[0].message, /^Module parse failed/);
      assert.equal(r.failures[0].stmt, "const x = ;");
      // `1:10`, counted from 0, with webpack's own caret under the semicolon: the 11th
      assert.equal(r.failures[0].col, 11);
      assert.equal(r.failures[0].stmt.indexOf(";") + 1, r.failures[0].col);
      // the loader advice is a suggestion, not what happened
      assert.doesNotMatch(JSON.stringify(r.failures), /appropriate loader|webpack\.js\.org/);
    } },
  // Captured with prettier 3.6. A file that will not parse is followed by its code frame,
  // every line of it tagged [error] like the diagnosis - and each was read as another
  // unparsable file, so one such file counted as four.
  { file: "prettier_parse_fail.txt", tool: "prettier", n: 2, check: (r) => {
      assert.equal(r.summary, "2 files failed the format check");
      assert.deepEqual(r.failures.map((f) => f.file), ["lint.js", "syn.js"]);
      assert.deepEqual([r.failures[1].line, r.failures[1].col, r.failures[1].stmt], [1, 11, "const x = ;"]);
      assert.doesNotMatch(JSON.stringify(r.failures), /\| +\^|2 \|/);
    } },
  // Captured with prettier 3. It exits non-zero while naming only files.
  { file: "prettier_fail.txt", tool: "prettier", n: 1, check: (r) => {
      assert.equal(r.failures[0].file, "ugly.js");
      // "needs formatting" reads like nothing went wrong; the guarantees suite says so
      assert.match(r.summary, /failed the format check/);
      // the last [warn] line is prettier's advice, not another file
      assert.doesNotMatch(JSON.stringify(r.failures), /--write/);
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
  { file: "oxlint_fail.txt", tool: "oxlint", n: 1, check: (r) => {
      assert.equal(r.failures[0].file, "lintme.js");
      assert.equal(r.failures[0].col, 5);
      // the rule is what you would disable; the plugin qualifier is not part of its name
      assert.equal(r.failures[0].code, "no-unused-vars");
      assert.match(r.failures[0].message, /^Variable 'unused' is declared but never used/);
      assert.doesNotMatch(r.failures[0].message, /help:/);
    } },
  // One real oxlint 1.82 run - three errors and two warnings over two files - in every
  // format it has. oxlint picks among them itself: a terminal gets the drawn report, a
  // pipe the same report in ASCII, a GitHub Actions job the annotations, and an AI agent
  // the one-line form, which was the only one read. The other ten came back with nothing.
  ...["agent_same", "default", "default_tty", "unix", "github", "stylish", "json", "checkstyle",
    "gitlab", "junit", "sarif"].map((form) => ({ file: `oxlint_${form}_fail.txt`, tool: "oxlint", n: 3, check: (r) => {
      assert.deepEqual(r.failures.map((f) => [f.file.split("/").pop(), f.line, f.code]).sort(),
        [["cart.js", 2, "no-debugger"], ["cart.js", 5, "eqeqeq"], ["checkout.js", 3, "no-cond-assign"]]);
      assert.equal(r.summary, "3 errors — 2 warnings hidden");
      assert.ok(r.failures.every((f) => !/help:|\[Error|eslint\(/.test(f.message)), JSON.stringify(r.failures));
    } })),
  // A file that does not parse has no rule. Where the format names oxlint some other
  // way - the drawn report's closing line, the document's own fields - it is still read.
  ...["parse_default", "parse_json"].map((form) => ({ file: `oxlint_${form}_fail.txt`, tool: "oxlint", n: 1, check: (r) => {
      assert.deepEqual([r.failures[0].file, r.failures[0].line, r.failures[0].col, r.failures[0].label],
        ["src/broken.js", 1, 28, "error"]);
      assert.equal(r.failures[0].message, "Expected `,` or `)` but found `{`");
    } })),
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
  // One run of stylelint, printed three ways. The default table was read; the other two
  // were not - unix fell through to the generic reader, which left the rule name buried
  // in the message and named no tool, and json was not read at all.
  { file: "stylelint_string_fail.txt", tool: "stylelint", n: 3, check: (r) => {
      assert.deepEqual(r.failures.map((f) => f.code),
        ["color-hex-length", "length-zero-no-unit", "no-duplicate-selectors"]);
      assert.equal(r.failures[0].message, 'Expected "#FFF" to be "#FFFFFF"');
    } },
  { file: "stylelint_unix_fail.txt", tool: "stylelint", n: 3, check: (r) => {
      assert.deepEqual(r.failures.map((f) => f.code),
        ["color-hex-length", "length-zero-no-unit", "no-duplicate-selectors"]);
      assert.equal(r.failures[0].file, "/home/dev/site/style.css");
      assert.equal(r.failures[0].line, 1);
      assert.equal(r.failures[0].col, 13);
      // the rule is the code, not a parenthesis left at the end of the sentence
      assert.doesNotMatch(JSON.stringify(r.failures.map((f) => f.message)), /\(color-hex-length\)/);
    } },
  // The same run under stylelint 17 - `string`, `unix` and `json` came out byte for byte as
  // they are above - with --formatter compact and tap, which read as nothing, and verbose.
  ...["compact", "tap", "verbose"].map((form) => ({ file: `stylelint_${form}_fail.txt`, tool: "stylelint", n: 3, check: (r) => {
      assert.deepEqual(r.failures.map((f) => [f.line, f.col, f.code, f.message]), [
        [1, 13, "color-hex-length", 'Expected "#FFF" to be "#FFFFFF"'], [1, 28, "length-zero-no-unit", "Disallowed unit"],
        [2, 1, "no-duplicate-selectors", 'Duplicate selector ".a", first used at line 1'],
      ]);
      assert.equal(r.summary, "3 problems (3 errors, 0 warnings)");
    } })),
  // ...and a second run with one rule set to warn. Every format says what the table's
  // tally says, where the machine formats used to say only how many errors they read.
  ...["string", "compact", "tap", "json"].map((form) => ({ file: `stylelint_warn_${form}_fail.txt`, tool: "stylelint", n: 2, check: (r) => {
      assert.deepEqual(r.failures.map((f) => f.code), ["length-zero-no-unit", "no-duplicate-selectors"]);
      assert.equal(r.summary, "3 problems (2 errors, 1 warning) — 1 warning hidden");
    } })),
  { file: "stylelint_json_fail.txt", tool: "stylelint", n: 3, check: (r) => {
      assert.deepEqual(r.failures.map((f) => f.code),
        ["color-hex-length", "length-zero-no-unit", "no-duplicate-selectors"]);
      assert.equal(r.failures[2].message, 'Duplicate selector ".a", first used at line 1');
      assert.equal(r.failures[2].line, 2);
      assert.equal(r.failures[2].col, 1);
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
      // ...but the other bracket says what the rule wanted, and it was being dropped
      // with the context, leaving "Spaces after list markers" and no number.
      assert.equal(r.failures[1].message, "Spaces after list markers [Expected: 1; Actual: 2]");
    } },
  // A rule may carry more than one alias. MD041 carries two, the pattern allowed one,
  // and the violation vanished: five in the log, four reported, nothing saying one went.
  { file: "markdownlint_aliases_fail.txt", tool: "markdownlint", n: 5, check: (r) => {
      assert.deepEqual(r.failures.map((f) => f.code), ["MD018", "MD041", "MD009", "MD010", "MD032"]);
      const md041 = r.failures.find((f) => f.code === "MD041");
      assert.equal(md041.message, "First line in a file should be a top-level heading");
      // the alias is not part of the message, however many segments it has
      assert.doesNotMatch(JSON.stringify(r.failures), /first-line-h1/);
    } },
  // markdownlint --json: the same violations as records, pretty-printed over many lines.
  // Nothing read it, so a run that reported five problems diagnosed none.
  { file: "markdownlint_json_fail.txt", tool: "markdownlint", n: 5, check: (r) => {
      assert.deepEqual([...r.failures.map((f) => f.code)].sort(),
        ["MD009", "MD010", "MD018", "MD032", "MD041"]);
      const md009 = r.failures.find((f) => f.code === "MD009");
      assert.equal(md009.message, "Trailing spaces [Expected: 0 or 2; Actual: 1]");
      assert.equal(md009.line, 2);
      assert.equal(md009.col, 10);
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
  { file: "eslint_config_fail.txt", tool: "eslint", n: 1, check: (r) => {
      // A broken config makes eslint crash, and the stack points into its own internals.
      assert.equal(r.summary, "configuration error");
      assert.match(r.failures[0].message, /Could not find "no-such-rule"/);
      assert.equal(r.failures[0].file, undefined, "eslint's own internals are not the answer");
      assert.doesNotMatch(JSON.stringify(r), /node_modules/);
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
  // Captured with pnpm 9 and yarn 1.22. pnpm indents its diagnostics with U+2009 THIN
  // SPACE, not a space - a pattern written [ \t] matches none of it, which is how the
  // whitespace class used across every parser came to be wrong.
  // Newer pnpm draws the same failure as a box rather than a column, and nothing read
  // it: the code was all the generic fallback could find, so a failed install said
  // ERR_PNPM_FETCH_404 and never which package, or why. The arrow is the diagnosis, the
  // cross is what pnpm was doing at the time, and `help:` is what to do next.
  { file: "pnpm_boxed_fail.txt", tool: "pnpm", n: 1, check: (r) => {
      assert.equal(r.failures[0].code, "ERR_PNPM_FETCH_404");
      // pnpm hard-wraps, and here the break lands inside the package name - joining the
      // continuation with a space would make one package into two
      assert.match(r.failures[0].message, /this-package-really-does-not-exist-9x7: Not Found - 404/);
      assert.doesNotMatch(r.failures[0].message, /this-\s+package/);
      // ...and a break between words keeps its space
      assert.match(r.failures[0].message, /registry, or you have no permission/);
      // the headline is one line, not the whole box
      assert.equal(r.summary, r.failures[0].message.split("\n")[0]);
      assert.match(r.summary, /^Failed to resolve dependency tree/);
      // the note about which header was sent is not the diagnosis
      assert.doesNotMatch(JSON.stringify(r.failures), /authorization header/i);
    } },
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
      // esbuild printed 5:24, counting from 0, with its caret under the semicolon
      assert.equal(f.col, 25);
      assert.equal(f.stmt.indexOf(";") + 1 + "  ".length, f.col, "the stmt is trimmed of the line's two-space indent");
      assert.match(f.message, /Expected "\)" but found ";"/);
      assert.match(f.stmt, /return sum \* \(1 \+ rate;/);
      assert.doesNotMatch(JSON.stringify(r), /node:internal/, "the wrapper's stack is not the failure");
    } },
  { file: "esbuild_resolve_fail.txt", tool: "esbuild", n: 1, check: (r) => {
      assert.equal(r.failures[0].file, "src/clean.js");
      // 1:21 counted from 0: the opening quote of the import, where vite's rolldown says 1:22
      assert.equal(r.failures[0].col, 22);
      assert.equal(r.failures[0].stmt.indexOf('"') + 1, r.failures[0].col);
      assert.match(r.failures[0].message, /Could not resolve "\.\/also-missing\.js"/);
      assert.equal(r.others, undefined, "the CLI wrapper's stack must not surface as a second tool");
    } },
  { file: "vite_syntax_fail.txt", tool: "vite", n: 1, check: (r) => {
      const f = r.failures[0];
      assert.equal(f.code, "PARSE_ERROR");
      assert.equal(f.file, "src/app.js");
      assert.equal(f.line, 5);
      // the same line esbuild_syntax_fail.txt reports: rolldown counts from 1, and says 25
      assert.equal(f.col, 25);
      assert.match(f.message, /Expected `,` or `\)` but found `;`/);
    } },
  { file: "vite_resolve_fail.txt", tool: "vite", n: 1, check: (r) => {
      const f = r.failures[0];
      assert.equal(f.code, "UNRESOLVED_IMPORT");
      assert.equal(f.file, "src/clean.js");
      assert.equal(f.line, 1);
      // and the import esbuild_resolve_fail.txt reports, at the same column
      assert.equal(f.col, 22);
      assert.match(f.message, /Could not resolve/);
    } },
  { file: "tsc_plain.txt", tool: "tsc", n: 3, check: (r) => {
      assert.equal(r.failures[0].title, "TS2551");
      assert.equal(r.failures[0].line, 2);
      assert.equal(r.failures[0].col, 52);
      assert.match(r.summary, /3 errors in 1 file/);
    } },
  // Not every refusal is a crash. eslint can stop before it lints anything and just say
  // why - a sentence with no error class, no location and no stack - and a log holding
  // only that came back "could not identify a diagnostic" over a command that exited 2
  // and said exactly what was wrong with it. Each of these names eslint or its own
  // option in the text, which is what makes the sentence eslint's and not some other
  // tool's prose.
  { file: "eslint_badflag_fail.txt", tool: "eslint", n: 1, check: (r) => {
      assert.equal(r.failures[0].label, "invalid option");
      assert.match(r.failures[0].message, /--bogus-flag/);
      // a headline has to admit the run failed
      assert.match(r.summary, /refused to run/);
    } },
  { file: "eslint_nofiles_fail.txt", tool: "eslint", n: 1, check: (r) => {
      assert.equal(r.failures[0].label, "no files matched");
      // the advice under the sentence is part of the answer
      assert.match(r.failures[0].message, /Please check for typing mistakes/);
      assert.doesNotMatch(JSON.stringify(r.failures), /node_modules/);
    } },
  { file: "eslint_formatter_fail.txt", tool: "eslint", n: 1, check: (r) => {
      assert.equal(r.failures[0].label, "formatter not installed");
      assert.match(r.failures[0].message, /eslint-formatter-unix/);
    } },
  // One run with warnings among its errors, in the table and in -f json. The failures
  // always agreed; the headlines did not - the table said how many warnings had stepped
  // aside and the document did not, so one run read two ways read two ways.
  { file: "eslint_warnings_text_same_fail.txt", tool: "eslint", n: 4, check: (r) => {
      assert.equal(r.summary, "6 problems (4 errors, 2 warnings) — 2 warnings hidden");
      assert.deepEqual(r.failures.map((f) => f.code),
        ["no-unused-vars", "no-undef", "no-undef", "no-undef"]);
    } },
  { file: "eslint_warnings_json_fail.txt", tool: "eslint", n: 4, check: (r) => {
      assert.equal(r.summary, "6 problems (4 errors, 2 warnings) — 2 warnings hidden");
      assert.deepEqual(r.failures.map((f) => f.code),
        ["no-unused-vars", "no-undef", "no-undef", "no-undef"]);
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
  { file: "biome_spaced_path_fail.txt", tool: "biome", n: 1, check: (r) => {
      assert.equal(r.failures[0].file, "my project/src/app.js");
      assert.equal(r.failures[0].code, "parse");
    } },
  // One `biome lint` run over two files, captured in the default output and in all five
  // of biome's --reporter formats. Only the default was read; the other five came back
  // with no diagnosis at all.
  { file: "biome_lint_text_same_fail.txt", tool: "biome", n: 2, check: (r) => {
      assert.deepEqual(r.failures.map((f) => f.code),
        ["lint/suspicious/noDebugger", "lint/suspicious/noDoubleEquals"]);
      assert.equal(r.failures[0].col, 3);
      assert.match(r.summary, /1 warning hidden/);
    } },
  { file: "biome_lint_json_fail.txt", tool: "biome", n: 2, check: (r) => {
      assert.deepEqual(r.failures.map((f) => f.code),
        ["lint/suspicious/noDebugger", "lint/suspicious/noDoubleEquals"]);
      assert.equal(r.failures[0].file, "src/cart.js");
      assert.equal(r.failures[0].line, 3);
      assert.equal(r.failures[0].col, 3);
      // the unused variable is a warning here too, and stands behind the errors
      assert.match(r.summary, /1 warning hidden/);
      assert.doesNotMatch(JSON.stringify(r.failures), /noUnusedVariables/);
    } },
  // The GitHub annotation shape is written by eslint and jest as well, so what marks
  // these as biome's is the rule category it puts in the title.
  { file: "biome_lint_github_fail.txt", tool: "biome", n: 2, check: (r) => {
      assert.deepEqual(r.failures.map((f) => f.code),
        ["lint/suspicious/noDebugger", "lint/suspicious/noDoubleEquals"]);
      assert.equal(r.failures[1].line, 2);
      assert.equal(r.failures[1].col, 14);
      assert.match(r.summary, /1 warning hidden/);
    } },
  // GitLab's Code Quality format carries no column, so none is invented for it. Its own
  // severity scale is not biome's: critical is an error, major is a warning.
  { file: "biome_lint_gitlab_fail.txt", tool: "biome", n: 2, check: (r) => {
      assert.deepEqual(r.failures.map((f) => f.code),
        ["lint/suspicious/noDebugger", "lint/suspicious/noDoubleEquals"]);
      assert.equal(r.failures[0].line, 3);
      assert.equal(r.failures[0].col, undefined);
      assert.match(r.summary, /1 warning hidden/);
    } },
  // JUnit records no severity at all - biome's warning and its errors are all written
  // as failures - so this reporter reports three where the others report two. Nothing
  // in the document can tell them apart, and nothing here pretends to. The rule comes
  // back as a class path and is changed back into biome's own category.
  { file: "biome_lint_junit_fail.txt", tool: "biome", n: 3, check: (r) => {
      assert.deepEqual(r.failures.map((f) => f.code), ["lint/correctness/noUnusedVariables",
        "lint/suspicious/noDebugger", "lint/suspicious/noDoubleEquals"]);
      assert.equal(r.failures[0].file, "src/cart.js");
      assert.equal(r.failures[0].line, 2);
      assert.doesNotMatch(JSON.stringify(r.failures), /org\.biome/);
      assert.doesNotMatch(r.summary, /hidden/);
    } },
  // The summary reporter prints no line numbers anywhere, so its findings are about
  // files and say so. The rules it lists are counted over the whole run and cannot be
  // attached to any one file, so they are named in the run's own line instead.
  { file: "biome_lint_summary_fail.txt", tool: "biome", n: 2, check: (r) => {
      assert.deepEqual(r.failures.map((f) => f.file), ["src/cart.js", "src/checkout.js"]);
      for (const f of r.failures) assert.equal(f.line, undefined);
      assert.match(r.failures[0].message, /1 error, 1 warning/);
      assert.match(r.summary, /lint\/suspicious\/noDebugger/);
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
  // Captured with eslint 9.39. A file that will not parse is a problem with no rule at
  // the end of its line, so the table pattern skipped it: 7 errors in the tally, 6 shown,
  // and the one hidden was the one that stopped a file being linted at all.
  { file: "eslint_parse_fail.txt", tool: "eslint", n: 7, check: (r) => {
      assert.match(r.summary, /^8 problems \(7 errors, 1 warning\)/);
      const parse = r.failures.find((f) => f.label === "parse error");
      assert.ok(parse, "the parsing error is missing");
      assert.deepEqual([parse.file, parse.line, parse.col, parse.code], ["/home/dev/app/syn.js", 1, 11, undefined]);
      assert.equal(parse.message, "Parsing error: Unexpected token ;");
    } },
  { file: "eslint_json_parse_fail.txt", tool: "eslint", n: 1, check: (r) => {
      // A file eslint could not parse carries no rule, because no rule ran.
      assert.equal(r.failures[0].code, undefined);
      assert.equal(r.failures[0].label, "parse error");
      assert.match(r.failures[0].message, /Parsing error: Unexpected token/);
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
  // A registry failure is coded E404 and prefixed 404, because the number is the HTTP
  // status underneath it. The code pattern was written E[A-Z_]+ and matched neither, so
  // the line naming the code was read as the first line of the MESSAGE, the failure
  // carried no code at all, and the repeated prefix and npm's standing advice spent the
  // rest of a three-line message - leaving out the line that says which package.
  { file: "npm_404_text_same_fail.txt", tool: "npm", n: 1, check: (r) => {
      assert.equal(r.failures[0].code, "E404");
      assert.match(r.failures[0].message, /this-package-really-does-not-exist-9x7@\^1\.0\.0/);
      // the code is the code; saying it again on every line is noise
      assert.doesNotMatch(r.failures[0].message, /^404\b/m);
      // and the standing advice for any 404 is not the diagnosis
      assert.doesNotMatch(r.failures[0].message, /tarball, folder/);
    } },
  // `npm --json` says it twice: the same block on stderr, a document on stdout. A
  // pipeline that keeps only stdout keeps only the document, and nothing read it.
  { file: "npm_404_json_fail.txt", tool: "npm", n: 1, check: (r) => {
      assert.equal(r.failures[0].code, "E404");
      assert.match(r.failures[0].message, /this-package-really-does-not-exist-9x7@\^1\.0\.0/);
      assert.doesNotMatch(r.failures[0].message, /tarball, folder/);
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
  // `deno lint`, which nothing read. Its default output is laid out exactly as rustc lays
  // out a compile error, so what tells them apart is on each finding: a rule that is a
  // lowercase kebab-case name, not E and four digits, on a JavaScript or TypeScript file.
  { file: "denolint_pretty_fail.txt", tool: "deno lint", n: 2, check: (r) => {
      assert.deepEqual(r.failures.map((f) => `${f.file}:${f.line}:${f.col}`),
        ["/home/dev/shop/orders.ts:1:14", "/home/dev/shop/customer.ts:1:34"]);
      assert.equal(r.failures[0].code, "no-explicit-any");
      // the rule's hint is what to write instead, and stays with the finding
      assert.equal(r.failures[0].message, "`any` type is not allowed\nUse a specific type other than `any`");
      assert.equal(r.failures[0].stmt, 'const order: any = "pending";');
      assert.doesNotMatch(JSON.stringify(r.failures), /docs\.deno\.com/);
    } },
  // --compact puts each finding on one line, with a file:// URL and no hint.
  { file: "denolint_compact_fail.txt", tool: "deno lint", n: 2, check: (r) => {
      assert.deepEqual(r.failures.map((f) => `${f.file}:${f.line}:${f.col}`),
        ["/home/dev/shop/orders.ts:1:14", "/home/dev/shop/customer.ts:1:34"]);
      assert.equal(r.failures[0].message, "`any` type is not allowed");
    } },
  // --json counts columns from zero, where the other two formats of the same run count
  // from one. Read as given, one finding would be two a column apart.
  { file: "denolint_json_fail.txt", tool: "deno lint", n: 2, check: (r) => {
      assert.deepEqual(r.failures.map((f) => `${f.file}:${f.line}:${f.col}`).sort(),
        ["/home/dev/shop/customer.ts:1:34", "/home/dev/shop/orders.ts:1:14"]);
    } },
  { file: "denofmt_fail.txt", tool: "deno fmt", n: 2, check: (r) => {
      assert.deepEqual(r.failures.map((f) => f.file), ["/home/dev/shop/orders.ts", "/home/dev/shop/customer.ts"]);
      for (const f of r.failures) assert.equal(f.line, undefined);
      // "not formatted" says nothing went wrong; the headline has to
      assert.equal(r.summary, "2 files failed the format check");
    } },
  // Three tools, one question: does the flag that changes how a diagnostic is PRINTED
  // change what is read out of it? Each is one real run captured in two forms.
  //
  // tsc --pretty is the default whenever tsc thinks it is talking to a terminal, and
  // plenty of tsconfigs turn it on. It writes "file:line:col - error TS2322:" where the
  // plain form writes "file(line,col): error TS2322:", and none of it was read.
  { file: "tsc_plain_same_fail.txt", tool: "tsc", n: 2, check: (r) => {
      assert.deepEqual(r.failures.map((f) => [f.file, f.line, f.col, f.code]), [
        ["bad.ts", 1, 7, "TS2322"], ["bad.ts", 2, 40, "TS2322"],
      ]);
    } },
  { file: "tsc_pretty_fail.txt", tool: "tsc", n: 2, check: (r) => {
      assert.deepEqual(r.failures.map((f) => [f.file, f.line, f.col, f.code]), [
        ["bad.ts", 1, 7, "TS2322"], ["bad.ts", 2, 40, "TS2322"],
      ]);
      // The source excerpt under the message is indented, and the squiggle under THAT
      // would read as part of tsc's explanation chain if a blank line did not end it.
      assert.doesNotMatch(JSON.stringify(r.failures), /~~|\bconst n:/);
    } },
  // `-f json-with-metadata` is the same report as `-f json` wrapped in an object beside
  // the rule metadata. Requiring a bracketed line meant the wrapped form read as nothing.
  { file: "eslint_json_metadata_fail.txt", tool: "eslint", n: 2, check: (r) => {
      assert.deepEqual(r.failures.map((f) => [f.line, f.col, f.code]), [
        [1, 7, "no-unused-vars"], [3, 22, "no-undef"],
      ]);
      assert.match(r.summary, /3 problems/);
    } },
];

let pass = 0, fail = 0;
for (const result of [runCases(CASES), agreeAcrossFormats([
  ["markdownlint", ["markdownlint_aliases_fail.txt", "markdownlint_json_fail.txt"]],
  // Unicode or ASCII, sass draws the same diagnostic.
  ["sass", ["sass_fail.txt", "sass_ascii_fail.txt"]],
  ["sass module loop", ["sass_module_loop_fail.txt", "sass_module_loop_ascii_fail.txt"]],
  ["stylelint", ["stylelint_string_fail.txt", "stylelint_unix_fail.txt", "stylelint_json_fail.txt",
    "stylelint_compact_fail.txt", "stylelint_tap_fail.txt", "stylelint_verbose_fail.txt"]],
  ["stylelint warnings", ["stylelint_warn_string_fail.txt", "stylelint_warn_compact_fail.txt",
    "stylelint_warn_tap_fail.txt", "stylelint_warn_json_fail.txt"]],
  ["biome", ["biome_lint_text_same_fail.txt", "biome_lint_json_fail.txt",
    "biome_lint_github_fail.txt"]],
  // GitLab's Code Quality format has nowhere to put a column, so that group is compared
  // without one. biome's JUnit and summary reporters print strictly less than the rest
  // and are pinned on their own above rather than being made to agree here.
  ["biome gitlab", ["biome_lint_text_same_fail.txt", "biome_lint_gitlab_fail.txt"], ["col"]],
  // eslint's stylish formatter trims the full stop its own rules write; the document
  // keeps it. That is eslint's doing, not the reader's, so the message is named here.
  ["eslint", ["eslint_warnings_text_same_fail.txt", "eslint_warnings_json_fail.txt"], ["message"]],
  ["npm", ["npm_404_text_same_fail.txt", "npm_404_json_fail.txt"]],
  ["oxlint", ["oxlint_agent_same_fail.txt", "oxlint_default_fail.txt", "oxlint_default_tty_fail.txt",
    "oxlint_unix_fail.txt", "oxlint_github_fail.txt", "oxlint_stylish_fail.txt", "oxlint_json_fail.txt",
    "oxlint_checkstyle_fail.txt", "oxlint_junit_fail.txt", "oxlint_sarif_fail.txt"]],
  // GitLab's Code Quality format has nowhere to put a column.
  ["oxlint gitlab", ["oxlint_agent_same_fail.txt", "oxlint_gitlab_fail.txt"], ["col"]],
  ["deno lint", ["denolint_pretty_fail.txt", "denolint_json_fail.txt"]],
  // --compact prints no hint, so the message is the one field it cannot share.
  ["deno lint compact", ["denolint_pretty_fail.txt", "denolint_compact_fail.txt"], ["message"]],
])]) {
  pass += result.pass;
  fail += result.fail;
}


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

// A refusal's range is where its sentence matched. The sentence was looked up as a whole
// line, and a line break inside the quoted option - which `[^']*` steps over - made the
// match two lines that equalled neither, so the failure was read from line -1 and the
// report gave its evidence as line 0, which no report may say.
try {
  const text = "Invalid option '--\nbogus-flag' - perhaps you meant '--flag'?\n";
  const report = createReport({ analysis: analyse(text), raw: text, exitCode: 2, inputMode: "pipe" });
  assert.equal(report.tool, "eslint");
  assert.equal(report.failures[0].label, "invalid option");
  assert.deepEqual(report.failures[0].evidence, [{ start: 1, end: 2 }]);
  console.log("  ok   an eslint refusal is read from the line it matched on");
  pass++;
} catch (e) { console.log(`  FAIL eslint refusal range\n       ${e.message}`); fail++; }

// A cut markdownlint document hands back records with fields missing, and what a
// document must carry to be recognised as markdownlint's at all does not include these.
// The parser is asked directly: analyse() would drop a malformed failure of its own
// accord and assert something true whatever this parser did.
try {
  const whole = fx("markdownlint_json_fail.txt");
  const full = markdownlint.extract(whole).failures.length;

  // a record that lost the sentence describing its rule: markdownlint names every rule
  // twice, so the second name stands in rather than leaving a failure with no message
  const undescribed = markdownlint.extract(whole.replace(/"ruleDescription":\s*"[^"]*",\s*/, ""));
  assert.equal(undescribed.failures.length, full, "the record was dropped rather than described");
  assert.ok(undescribed.failures.every((f) => f.message), "a failure reached the reader with no message");

  // a record whose rule names survived as an empty array says nothing at all
  const unnamed = markdownlint.extract(whole.replace(/"ruleNames":\s*\[[^\]]*\]/, '"ruleNames": []'));
  assert.equal(unnamed.failures.length, full - 1, "the nameless record was reported anyway");
  assert.ok(unnamed.failures.every((f) => f.code), "a failure reached the reader with no code");

  console.log("  ok   a markdownlint record missing what names it is not reported half-read");
  pass++;
} catch (e) { console.log(`  FAIL markdownlint damaged record\n       ${e.message}`); fail++; }

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
