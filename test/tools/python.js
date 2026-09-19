// Python: pytest, unittest and tracebacks, flake8, pylint, black, ruff, mypy, pyright, pip.
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
  // One real pyright 1.1.414 run, as text and as --outputjson: three errors and a warning.
  { file: "pyright_text_same_fail.txt", tool: "pyright", n: 3, check: (r) => {
      assert.equal(r.summary, "3 errors — 1 warning hidden");
    } },
  { file: "pyright_json_fail.txt", tool: "pyright", n: 3, check: (r) => {
      // It was read as nothing at all.
      assert.deepEqual(r.failures.map((f) => [f.line, f.col, f.code]),
        [[2, 12, "reportReturnType"], [7, 25, "reportUndefinedVariable"], [10, 7, "reportArgumentType"]],
        "the document counts lines and characters from zero");
      assert.equal(r.failures[0].message, 'Type "int" is not assignable to return type "str"\n"int" is not assignable to "str"');
      assert.equal(r.summary, "3 errors — 1 warning hidden", "the document's own counts");
      // A job that runs pyright once per package writes one document per package.
      const doc = fx("pyright_json_fail.txt");
      const both = analyse(`${doc}\n${doc.replaceAll("/home/dev/shop/app/", "/home/dev/billing/app/")}`);
      assert.equal(both.failures.length, 6, "only the first package's document was read");
      assert.equal(both.summary, "6 errors — 2 warnings hidden");
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
      // pylint counts columns from 0 - `lint_me.py:1:0:` is the start of the module -
      // and a column here counts from 1
      assert.deepEqual(r.failures.map((f) => f.col), [1, 1, 5, 1]);
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
  // One real flake8 7.3 run, default and --format=pylint. The second went to the generic
  // reader: the code in the message and no code to group on.
  { file: "flake8_pylint_fail.txt", tool: "flake8", n: 4, check: (r) => {
      assert.deepEqual(r.failures.map((f) => [f.line, f.code]), [[1, "F401"], [2, "E302"], [2, "E231"], [3, "F841"]]);
      assert.equal(r.failures[0].message, "'os' imported but unused");
      assert.ok(r.failures.every((f) => f.col === undefined), "this format prints no column, and none is invented");
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
  { file: "pytest_collect_fail.txt", tool: "pytest", n: 1, check: (r) => {
      assert.match(r.failures[0].message, /ModuleNotFoundError: No module named 'nonexistent_module'/);
      assert.doesNotMatch(JSON.stringify(r.failures), /importlib|_bootstrap/,
        "python's own import machinery is not the cause");
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
  // One mypy run over two files, in its default output and in --output=json. The JSON
  // form carries a column the text form does not print unless asked, and a `hint` where
  // the text form writes a note under the error.
  { file: "mypy_text_same_fail.txt", tool: "mypy", n: 4, check: (r) => {
      assert.deepEqual(r.failures.map((f) => f.code),
        ["return-value", "assignment", "operator", "return-value"]);
      assert.equal(r.failures[0].col, undefined);
      assert.equal(r.summary, "4 errors in 2 files");
    } },
  { file: "mypy_json_fail.txt", tool: "mypy", n: 4, check: (r) => {
      assert.deepEqual(r.failures.map((f) => f.code),
        ["return-value", "assignment", "operator", "return-value"]);
      assert.equal(r.failures[0].file, "pkg/ship.py");
      assert.equal(r.failures[0].line, 2);
      assert.equal(r.failures[0].col, 11);
      assert.equal(r.failures[0].message,
        'Incompatible return value type (got "float", expected "str")');
    } },
  { file: "mypy_fail.txt", tool: "mypy", n: 3, check: (r) => {
      assert.equal(r.summary, "3 errors in 1 file");          // "1 file", not "1 files"
      assert.equal(r.failures[0].file, "typed.py");
      assert.equal(r.failures[0].line, 2);
      assert.equal(r.failures[0].title, "return-value");       // mypy's [code] becomes the title
      assert.match(r.failures[2].message, /Argument 1 to "total"/);
      assert.ok(!r.failures.some((f) => /note:/.test(f.message)), "notes are not errors");
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
  // One run of pylint over two modules, captured in all five of its formats. The text
  // form was read; the other four were not. Three errors, and the docstring advice and
  // the unused variable step aside and are counted.
  { file: "pylint_text_same_fail.txt", tool: "pylint", n: 3, check: (r) => {
      assert.deepEqual(r.failures.map((f) => f.code), ["E1101", "E0602", "E0602"]);
      assert.equal(r.failures[0].file, "my project/orders.py");
      // pylint printed 9:42, counting from 0
      assert.equal(r.failures[0].col, 43);
      assert.match(r.summary, /3 advisory hidden/);
    } },
  // -f parseable and -f msvs put the code and the symbolic name in a bracket, and put
  // the enclosing class or function after it - parseable behind a comma, msvs behind
  // nothing at all. Reading the comma as the separator found every finding at module
  // level and lost every finding inside a class.
  { file: "pylint_parseable_fail.txt", tool: "pylint", n: 3, check: (r) => {
      assert.deepEqual(r.failures.map((f) => f.code), ["E1101", "E0602", "E0602"]);
      assert.equal(r.failures[0].file, "my project/orders.py");
      assert.equal(r.failures[0].title, "no-member");
      // the format prints no column, so none is invented
      assert.equal(r.failures[0].col, undefined);
      // the enclosing method is not part of the message
      assert.doesNotMatch(JSON.stringify(r.failures), /Basket\.total/);
    } },
  { file: "pylint_msvs_fail.txt", tool: "pylint", n: 3, check: (r) => {
      assert.deepEqual(r.failures.map((f) => f.code), ["E1101", "E0602", "E0602"]);
      assert.equal(r.failures[0].line, 9);
      assert.equal(r.failures[0].message, "Instance of 'Basket' has no 'lines' member");
      assert.doesNotMatch(JSON.stringify(r.failures), /Basket\.total/);
    } },
  // -f json is an array of messages, -f json2 the same messages in an object beside the
  // run's statistics - with the one key renamed. Both are pretty-printed over many
  // lines, so neither can be found by looking for a line that parses.
  { file: "pylint_json_fail.txt", tool: "pylint", n: 3, check: (r) => {
      assert.deepEqual(r.failures.map((f) => f.code), ["E1101", "E0602", "E0602"]);
      assert.equal(r.failures[2].file, "my project/shipping.py");
      assert.equal(r.failures[2].col, 21);
      assert.match(r.summary, /3 advisory hidden/);
    } },
  { file: "pylint_json2_fail.txt", tool: "pylint", n: 3, check: (r) => {
      assert.deepEqual(r.failures.map((f) => f.code), ["E1101", "E0602", "E0602"]);
      assert.deepEqual(r.failures.map((f) => f.title),
        ["no-member", "undefined-variable", "undefined-variable"]);
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
  // One real pytest run in five traceback styles. --tb is a flag CI configs set
  // constantly, and only the default was read properly: --tb=short lost every location,
  // --tb=line and --tb=no fell to the fallback (which made two failures into four), and
  // --tb=native was left to the traceback parser - right failures, wrong tool, no counts.
  { file: "pytest_tb_long_same_fail.txt", tool: "pytest", n: 2, check: (r) => {
      assert.equal(r.summary, "2 failed, 1 passed in 0.01s");
      assert.deepEqual(r.failures.map((f) => [f.title, f.file, f.line]), [
        ["test_invoice_total", "test_shop.py", 6],
        ["test_missing_key", "test_shop.py", 11],
      ]);
    } },
  { file: "pytest_tb_short_fail.txt", tool: "pytest", n: 2, check: (r) => {
      // --tb=short moves the location to the top of the block and writes "in <function>"
      // after it, where the default writes the exception or nothing.
      assert.deepEqual(r.failures.map((f) => [f.file, f.line]), [
        ["test_shop.py", 6], ["test_shop.py", 11],
      ], "the location is on the first line of the block, not the last");
    } },
  { file: "pytest_tb_line_fail.txt", tool: "pytest", n: 2, check: (r) => {
      // No block is printed at all. The summary names the tests; the one-line locations
      // are matched to them by the message they share, not by the order they appear in.
      assert.deepEqual(r.failures.map((f) => [f.title, f.line]), [
        ["test_invoice_total", 6], ["test_missing_key", 11],
      ]);
      assert.equal(r.failures[1].message, "KeyError: 'taxrate'");
    } },
  { file: "pytest_tb_no_fail.txt", tool: "pytest", n: 2, check: (r) => {
      // Nothing but the summary. It still names both tests and what they raised.
      assert.deepEqual(r.failures.map((f) => [f.title, f.file]), [
        ["test_invoice_total", "test_shop.py"], ["test_missing_key", "test_shop.py"],
      ]);
      assert.equal(r.failures[0].line, undefined, "no line is printed, so none is invented");
    } },
  { file: "pytest_tb_native_fail.txt", tool: "pytest", n: 2, check: (r) => {
      // A Python traceback, mostly pytest's own machinery. The frame that matters is the
      // last one outside it.
      assert.deepEqual(r.failures.map((f) => [f.file, f.line]), [
        ["/home/dev/pytest/test_shop.py", 6], ["/home/dev/pytest/test_shop.py", 11],
      ]);
      assert.doesNotMatch(JSON.stringify(r.failures), /site-packages|_pytest|pluggy/);
    } },
  // One real ruff run in five of its --output-format settings. Only the default was read:
  // `concise` and `grouped` were claimed by flake8, whose `file:line:col: CODE message`
  // is the same shape; `github` was mangled by it into a file called
  // "lint_me.py,line=1,col=8,...::lint_me.py"; `json` said nothing at all.
  { file: "ruff_full_same_fail.txt", tool: "ruff", n: 3, check: (r) => {
      assert.equal(r.summary, "3 errors");
      assert.deepEqual(r.failures.map((f) => [f.file, f.line, f.col, f.code]), [
        ["lint_me.py", 1, 8, "F401"], ["lint_me.py", 2, 8, "F401"], ["lint_me.py", 6, 5, "F841"],
      ]);
    } },
  { file: "ruff_concise_fail.txt", tool: "ruff", n: 3, check: (r) => {
      assert.deepEqual(r.failures.map((f) => [f.line, f.code]), [[1, "F401"], [2, "F401"], [6, "F841"]]);
      // "[*]" marks the finding fixable - ruff talking about its own options, not code.
      assert.doesNotMatch(JSON.stringify(r.failures), /\[\*\]/);
    } },
  { file: "ruff_grouped_fail.txt", tool: "ruff", n: 3, check: (r) => {
      // The file is on its own line and the findings are indented beneath it.
      assert.equal(r.failures.every((f) => f.file === "lint_me.py"), true);
      assert.deepEqual(r.failures.map((f) => f.line), [1, 2, 6]);
    } },
  { file: "ruff_github_fail.txt", tool: "ruff", n: 3, check: (r) => {
      assert.equal(r.failures[0].file, "/home/dev/ruff/lint_me.py", "the annotation names the file once");
      assert.deepEqual(r.failures.map((f) => [f.line, f.col]), [[1, 8], [2, 8], [6, 5]]);
      // A workflow command cannot span lines, so the advice is percent-encoded.
      assert.doesNotMatch(JSON.stringify(r.failures), /%0A|endLine=|::/);
      assert.match(r.failures[0].message, /Remove unused import/);
    } },
  // Captured with ruff 0.15. A finding that spans lines is annotated with `line=1,
  // endLine=2` and no column, since a workflow annotation may only carry one on a single
  // line. Requiring the column sent that line to the concise pattern, which read the
  // whole annotation up to the message's own `shop.py:1:1:` as the file.
  { file: "ruff_github_multiline_fail.txt", tool: "ruff", n: 4, check: (r) => {
      assert.ok(r.failures.every((f) => f.file === "/home/dev/app/shop.py"), JSON.stringify(r.failures.map((f) => f.file)));
      assert.deepEqual(r.failures.map((f) => [f.code, f.line, f.col]), [["I001", 1, 1], ["F401", 1, 8], ["UP035", 2, 1], ["UP006", 3, 18]]);
      assert.doesNotMatch(JSON.stringify(r.failures), /%0A|endLine=|::/);
      assert.match(r.failures[0].message, /Organize imports/);
    } },
  { file: "ruff_json_fail.txt", tool: "ruff", n: 3, check: (r) => {
      assert.deepEqual(r.failures.map((f) => [f.line, f.col, f.code]), [
        [1, 8, "F401"], [2, 8, "F401"], [6, 5, "F841"],
      ]);
    } },
];

let pass = 0, fail = 0;
for (const result of [runCases(CASES), agreeAcrossFormats([
  ["pylint", ["pylint_text_same_fail.txt", "pylint_parseable_fail.txt", "pylint_msvs_fail.txt",
    "pylint_json_fail.txt", "pylint_json2_fail.txt"], ["col"]],
  // mypy's default output prints no column unless it is asked for one; --output=json
  // always carries it.
  ["mypy", ["mypy_text_same_fail.txt", "mypy_json_fail.txt"], ["col"]],
  ["pyright", ["pyright_text_same_fail.txt", "pyright_json_fail.txt"]],
  // flake8's pylint format prints no column.
  ["flake8 pylint format", ["flake8_default_same_fail.txt", "flake8_pylint_fail.txt"], ["col"]],
])]) {
  pass += result.pass;
  fail += result.fail;
}


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
// Five traceback styles, one run. The style changes how much is printed, never which
// tests failed or what they raised.
try {
  const styles = ["long_same", "short", "line", "no", "native"]
    .map((n) => analyse(fx(`pytest_tb_${n}_fail.txt`)));
  const named = (r) => r.failures.map((f) => f.title);
  for (const r of styles) {
    assert.equal(r.tool, "pytest");
    assert.deepEqual(named(r), ["test_invoice_total", "test_missing_key"]);
    assert.match(r.summary, /2 failed, 1 passed/);
    assert.match(r.failures[1].message, /KeyError: 'taxrate'/);
  }
  console.log("  ok   every pytest traceback style names the same failures");
  pass++;
} catch (e) { console.log(`  FAIL pytest traceback styles\n       ${e.message}`); fail++; }
// --output-format decides how much ruff prints, never what it found. The first five were
// read already; json-lines, junit, gitlab, rdjson, azure and sarif, captured from the same
// run with ruff 0.16 - `full` and `concise` came out byte for byte as they are here -
// read as nothing.
try {
  const forms = ["full_same", "concise", "grouped", "github", "json", "json_lines", "junit", "gitlab", "rdjson",
    "azure", "sarif"]
    .map((n) => [n, analyse(fx(`ruff_${n}_fail.txt`))]);
  const where = (r) => r.failures.map((f) => [f.line, f.col, f.code]);
  for (const [name, r] of forms) {
    assert.equal(r.tool, "ruff", `${name}: wrong tool`);
    assert.deepEqual(where(r), [[1, 8, "F401"], [2, 8, "F401"], [6, 5, "F841"]], `${name}: different findings`);
    // The message is ruff's own, and the fix is added where the format carries one.
    assert.match(r.failures[0].message, /^`os` imported but unused(\nRemove unused import: `os`)?$/, name);
    assert.equal(r.summary, "3 errors", name);
  }
  console.log("  ok   every ruff output format reports the same findings");
  pass++;
} catch (e) { console.log(`  FAIL ruff output formats\n       ${e.message}`); fail++; }

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
