// Infrastructure: docker, kubectl, terraform, git, shellcheck, yamllint.
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
  // The same syntax failure captured from current Terraform in its two no-colour
  // encodings. `validate -json` used to fall back to raw output, and `-no-color`
  // removes the box entirely on this release, which made the text form disappear too.
  { file: "terraform_validate_json_fail.txt", tool: "terraform", n: 1, check: (r) => {
      assert.equal(r.failures[0].file, "main.tf");
      assert.equal(r.failures[0].line, 2);
      assert.equal(r.failures[0].col, 10);
      assert.equal(r.failures[0].title, "Invalid expression");
      assert.equal(r.failures[0].stmt, "input =");
      assert.match(r.failures[0].message, /Expected the start of an expression/);
    } },
  { file: "terraform_validate_nocolor_fail.txt", tool: "terraform", n: 1, check: (r) => {
      assert.equal(r.failures[0].file, "main.tf");
      assert.equal(r.failures[0].line, 2);
      assert.equal(r.failures[0].title, "Invalid expression");
      assert.equal(r.failures[0].stmt, "input =");
    } },
  // `plan -json` is not the document returned by `validate -json`; it is a stream of
  // one JSON UI event per line. Treating that line as prose lost every structured fact.
  { file: "terraform_plan_json_fail.txt", tool: "terraform", n: 1, check: (r) => {
      assert.equal(r.failures[0].file, "main.tf");
      assert.equal(r.failures[0].line, 2);
      assert.equal(r.failures[0].col, 10);
      assert.equal(r.failures[0].title, "Invalid expression");
      assert.equal(r.failures[0].stmt, "input =");
      assert.doesNotMatch(JSON.stringify(r.failures), /@timestamp|terraform\.ui/);
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
  // One shellcheck run over two scripts, captured in all five of its formats. Two of the
  // ten findings are errors and the rest stand behind them. -f json, -f json1 and
  // -f checkstyle were not read at all - and the checkstyle document quotes its
  // attributes with single quotes, which the shared XML reader did not know, so it found
  // no attributes and read the whole document as empty.
  { file: "shellcheck_tty_same_fail.txt", tool: "shellcheck", n: 2, check: (r) => {
      assert.deepEqual(r.failures.map((f) => f.code), ["SC1073", "SC1072"]);
      assert.equal(r.failures[0].file, "inputs/b.sh");
      assert.equal(r.failures[0].col, 8);
      assert.match(r.summary, /8 lower-severity findings hidden/);
    } },
  { file: "shellcheck_gcc_same_fail.txt", tool: "shellcheck", n: 2, check: (r) => {
      assert.deepEqual(r.failures.map((f) => f.code), ["SC1073", "SC1072"]);
      assert.match(r.summary, /8 lower-severity findings hidden/);
    } },
  // The code is a number in the JSON forms, and the two differ only in whether the
  // findings are the document or sit inside one.
  { file: "shellcheck_json_fail.txt", tool: "shellcheck", n: 2, check: (r) => {
      assert.deepEqual(r.failures.map((f) => f.code), ["SC1073", "SC1072"]);
      assert.equal(r.failures[0].line, 4);
      assert.equal(r.failures[0].col, 8);
      assert.match(r.summary, /8 lower-severity findings hidden/);
    } },
  { file: "shellcheck_json1_fail.txt", tool: "shellcheck", n: 2, check: (r) => {
      assert.deepEqual(r.failures.map((f) => f.code), ["SC1073", "SC1072"]);
      assert.match(r.summary, /8 lower-severity findings hidden/);
    } },
  // checkstyle is a shape other linters write too, so what makes a finding shellcheck's
  // is the check that declares itself as ShellCheck.SC####.
  { file: "shellcheck_checkstyle_fail.txt", tool: "shellcheck", n: 2, check: (r) => {
      assert.deepEqual(r.failures.map((f) => f.code), ["SC1073", "SC1072"]);
      assert.equal(r.failures[0].file, "inputs/b.sh");
      // the numeric character references are decoded, not left as &#40;
      assert.doesNotMatch(JSON.stringify(r.failures), /&#\d+;/);
      assert.match(r.summary, /8 lower-severity findings hidden/);
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
  // One yamllint run over two files in all three of its formats. -f github writes the
  // workflow annotations every tool's GitHub formatter writes, so what marks these as
  // yamllint's is inside the message: yamllint puts its own parsable line there, which
  // says the position a second time. If the two positions disagree it is not yamllint's.
  { file: "yamllint_text_same_fail.txt", tool: "yamllint", n: 3, check: (r) => {
      assert.deepEqual(r.failures.map((f) => f.code),
        ["colons", "trailing-spaces", "key-duplicates"]);
      assert.match(r.summary, /2 warnings hidden/);
    } },
  { file: "yamllint_parsable_same_fail.txt", tool: "yamllint", n: 3, check: (r) => {
      assert.deepEqual(r.failures.map((f) => f.code),
        ["colons", "trailing-spaces", "key-duplicates"]);
      assert.equal(r.failures[2].file, "config.yml");
    } },
  { file: "yamllint_github_fail.txt", tool: "yamllint", n: 3, check: (r) => {
      assert.deepEqual(r.failures.map((f) => f.code),
        ["colons", "trailing-spaces", "key-duplicates"]);
      assert.equal(r.failures[0].file, "deploy.yml");
      assert.equal(r.failures[0].line, 1);
      assert.equal(r.failures[0].col, 7);
      // the position yamllint repeats inside the annotation is not part of the message
      assert.equal(r.failures[0].message, "too many spaces after colon");
      assert.doesNotMatch(JSON.stringify(r.failures), /\[colons\]/);
      assert.match(r.summary, /2 warnings hidden/);
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
  // Captured with Terraform v1.16.1. `terraform fmt -check` is in nearly every Terraform
  // pipeline, and with -diff it says where; without it, only which files. None of it was
  // read: the job exited 3 and whatbroke handed the diff back whole.
  { file: "terraform_fmt_fail.txt", tool: "terraform fmt", n: 1, check: (r) => {
      assert.equal(r.summary, "1 file failed the format check");
      assert.equal(r.failures[0].file, "main.tf");
      assert.equal(r.failures[0].line, 2, "the line the change starts at, not the hunk's");
      assert.equal(r.failures[0].stmt, `bucket = "shop-invoices"`);
    } },
  { file: "terraform_fmt_hunks_fail.txt", tool: "terraform fmt", n: 2, check: (r) => {
      // One file, two regions: a hunk is a place, and the headline still counts files.
      assert.equal(r.summary, "1 file failed the format check");
      assert.deepEqual(r.failures.map((f) => `${f.file}:${f.line}`), ["network.tf:2", "network.tf:20"]);
      assert.equal(r.failures[1].stmt, 'resource  "aws_route_table"  "private" {');
    } },
  { file: "terraform_fmt_recursive_fail.txt", tool: "terraform fmt", n: 2, check: (r) => {
      // -recursive walks into modules, and each file names its own path from the root.
      assert.equal(r.summary, "2 files failed the format check");
      assert.deepEqual(r.failures.map((f) => f.file),
        ["modules/billing/main.tf", "providers.tf"]);
      assert.equal(r.failures[0].stmt, "type=number");
      assert.equal(r.failures[1].line, 10, "a hunk in the middle of a file says where");
    } },
  // terraform refusing a subcommand: one sentence, no box, no "Error:", and the whole log.
  { file: "terraform_nocommand_fail.txt", tool: "terraform", n: 1, check: (r) => {
      assert.equal(r.summary, "the command was refused");
      assert.equal(r.failures[0].subject, "notasubcommand");
    } },
  // cmake refusing before it reads a script: the message is on the banner's own line and
  // there is no location, so the pattern that ends at the colon matched none of it.
  { file: "cmake_nosource_fail.txt", tool: "cmake", n: 1, check: (r) => {
      assert.equal(r.failures[0].title, "cmake error");
      assert.match(r.failures[0].message, /does not appear to contain CMakeLists\.txt/);
      assert.equal("file" in r.failures[0], false, "nothing was read, so there is no location");
    } },
  { file: "cmake_generator_fail.txt", tool: "cmake", n: 1, check: (r) => {
      assert.match(r.failures[0].message, /Could not create named generator NoSuchGenerator/);
      // The list of generators it prints underneath is help, not more failures.
      assert.equal(r.failures.length, 1);
    } },
];

let pass = 0, fail = 0;
for (const result of [runCases(CASES), agreeAcrossFormats([
  ["yamllint", ["yamllint_text_same_fail.txt", "yamllint_parsable_same_fail.txt",
    "yamllint_github_fail.txt"]],
  // shellcheck's default block format is the only one that quotes the offending source
  // line, so `stmt` is not compared across the group - but it is not in the compared
  // fields anyway.
  ["shellcheck", ["shellcheck_tty_same_fail.txt", "shellcheck_gcc_same_fail.txt",
    "shellcheck_json_fail.txt", "shellcheck_json1_fail.txt",
    "shellcheck_checkstyle_fail.txt"]],
])]) {
  pass += result.pass;
  fail += result.fail;
}


// Current Terraform removes its diagnostic box under `-no-color`, while `-json`
// returns the same facts with an exact column. Both are real captures of one invalid
// expression and must agree on everything the text form actually carries.
try {
  const json = analyse(fx("terraform_validate_json_fail.txt"));
  const text = analyse(fx("terraform_validate_nocolor_fail.txt"));
  const facts = (r) => r.failures.map((f) =>
    [f.file, f.line, f.title, f.subject, f.severity, f.message, f.stmt]);
  assert.equal(json.tool, text.tool);
  assert.equal(json.summary, text.summary);
  assert.deepEqual(facts(json), facts(text),
    "validate -json and -no-color disagree about the invalid expression");
  assert.equal(json.failures[0].col, 10, "the machine range's column was discarded");
  const stream = analyse(fx("terraform_plan_json_fail.txt"));
  assert.equal(stream.tool, json.tool);
  assert.equal(stream.summary, json.summary);
  assert.deepEqual(facts(stream), facts(text),
    "plan -json and validate -no-color disagree about the invalid expression");
  assert.equal(stream.failures[0].col, 10, "the streamed machine range's column was discarded");
  assert.notEqual(analyse('{"format_version":"1.0","valid":false,"error_count":0,"warning_count":0,"diagnostics":[]}')?.tool,
    "terraform", "an empty lookalike report produced a Terraform failure");
  console.log("  ok   terraform validate -json says what its text report says");
  pass++;
} catch (e) { console.log(`  FAIL terraform json vs text\n       ${e.message}`); fail++; }

// terraform spells its diff's halves `old/<path>` and `new/<path>`, and the path is the
// same in both. That pair is the whole defence against every other diff a build prints:
// git writes `a/<path>` and `b/<path>`, minitest and PHPUnit write `--- expected` and
// `+++ actual`, and either would otherwise be read as unformatted HCL.
try {
  const { EXTRACTORS } = await import("../../src/index.js");
  const tf = EXTRACTORS.find((e) => e.name === "terraform fmt");
  const hunk = "@@ -1,4 +1,4 @@\n-old\n+new\n";
  assert.equal(tf.detect(`diff --git a/x b/x\n--- a/x\n+++ b/x\n${hunk}`), false, "git's diff is not terraform's");
  assert.equal(tf.detect(`--- expected\n+++ actual\n${hunk}`), false, "a test runner's value diff is not terraform's");
  assert.equal(tf.detect(`--- old/x.tf\n+++ new/y.tf\n${hunk}`), false, "two different files are not one file's change");
  assert.equal(tf.detect(`--- old/x.tf\n+++ new/x.tf\n${hunk}`), true);
  const claimed = readdirSync(join(here, "fixtures")).sort()
    .filter((n) => { try { return tf.detect(fx(n)); } catch { return false; } });
  assert.deepEqual(claimed, ["terraform_fmt_fail.txt", "terraform_fmt_hunks_fail.txt",
    "terraform_fmt_recursive_fail.txt"]);
  console.log("  ok   terraform fmt reads its own diffs and nobody else's");
  pass++;
} catch (e) { console.log(`  FAIL terraform fmt diff shape\n       ${e.message}`); fail++; }

// And a file's diff ends where another one begins, so a pipeline that formats and then
// tests does not have the test runner's value diff read as more unformatted HCL.
try {
  const tf = fx("terraform_fmt_fail.txt"), minitest = fx("minitest_invoice_fail.txt");
  const count = (r) => (r?.failures.length ?? 0) + (r?.others ?? []).reduce((n, o) => n + o.failures.length, 0);
  const apart = count(analyse(tf)) + count(analyse(minitest));
  assert.equal(count(analyse(`${tf}\n${minitest}`)), apart,
    "a terraform fmt diff must not read on into another tool's diff");
  console.log("  ok   a terraform fmt diff stops where its own diff stops");
  pass++;
} catch (e) { console.log(`  FAIL terraform fmt diff bound\n       ${e.message}`); fail++; }

// Another tool can insert indented output inside a hunk. It resembles unchanged diff
// context but cannot move a removed line outside the hunk's declared old-file range.
try {
  const clean = fx("terraform_fmt_hunks_fail.txt");
  const interleaved = clean.replace("@@ -1,5 +1,5 @@\n",
    `@@ -1,5 +1,5 @@\n${'    "tests": 2,\n'.repeat(18)}`);
  const findings = analyse(interleaved).failures;
  assert.deepEqual(findings.map((f) => [f.file, f.line, f.stmt]),
    [["network.tf", 20, 'resource  "aws_route_table"  "private" {']],
    "interleaved context must not invent another finding at the next hunk's location");
  console.log("  ok   interleaved terraform fmt context stays within its hunk");
  pass++;
} catch (e) { console.log(`  FAIL terraform fmt interleaving\n       ${e.message}`); fail++; }

// terraform names itself in the sentence, which is what makes it claimable at all.
try {
  const { EXTRACTORS } = await import("../../src/index.js");
  const tf = EXTRACTORS.find((e) => e.name === "terraform");
  assert.equal(tf.detect('Terraform has no command named "wibble".\n'), true);
  assert.equal(tf.detect('OpenTofu has no command named "wibble".\n'), true);
  assert.equal(tf.detect('kubectl has no command named "wibble".\n'), false);
  // cmake names itself on its own banner, which is what makes a location-less sentence
  // claimable at all.
  const cm = EXTRACTORS.find((e) => e.name === "cmake");
  assert.equal(cm.detect("CMake Error: The source directory does not exist.\n"), true);
  assert.equal(cm.detect("CMake Warning: something minor.\n"), true);
  assert.equal(cm.detect("Error: the source directory does not exist.\n"), false);
  assert.equal(cm.detect("CMake Error:\n"), true, "the located form still reads");
  console.log("  ok   a refused subcommand is terraform's only when terraform says so");
  pass++;
} catch (e) { console.log(`  FAIL terraform refused command\n       ${e.message}`); fail++; }

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
