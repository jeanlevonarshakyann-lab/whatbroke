// Reading any log: the ways a log reaches whatbroke, what is refused, and what holds for every parser.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { analyse } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n) => readFileSync(join(here, "fixtures", n), "utf8");
const cli = join(here, "..", "bin", "whatbroke.js");

let pass = 0, fail = 0;


// A self-closing XML element holds nothing after it.
//
// Node's parser steps over stacks that are quoted INSIDE a <failure> or <error> element,
// because a JUnit report of a crash is somebody's report and not the crash. It found the
// end of such an element by looking for the closing tag - and `<error ... />` has none,
// so a document made entirely of self-closing errors opened a region that never closed
// and swallowed everything printed after it. shellcheck's checkstyle report is exactly
// that document, and a Node crash printed after one disappeared.
try {
  const crash = fx("node_stack.txt");
  const alone = analyse(crash);
  const after = analyse(fx("shellcheck_checkstyle_fail.txt") + "\n" + crash);
  const nodes = [after, ...(after.others ?? [])].filter((r) => r.tool === "node");
  assert.equal(nodes.length, 1, "the crash after a checkstyle report went missing");
  assert.deepEqual(nodes[0].failures.map((f) => `${f.file}:${f.line}`),
    alone.failures.map((f) => `${f.file}:${f.line}`));
  // ...and the reason the step-over exists still holds: a stack quoted inside a real
  // <failure>...</failure> body is still the report's, not a crash of its own.
  const quoted = analyse(fx("mocha_xunit_fail.txt"));
  assert.ok(![quoted, ...(quoted.others ?? [])].some((r) => r.tool === "node"),
    "a stack quoted inside a <failure> body was read as a crash");
  console.log("  ok   a self-closing <error/> does not swallow the rest of the log");
  pass++;
} catch (e) {
  console.log(`  FAIL self-closing XML element\n       ${e.message}`);
  fail++;
}

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
    "CSI colour and erase controls": (t) => t.split("\n").map((line) => line
      ? `\x1b[2K\x1b[31m${line}\x1b[0m`
      : line).join("\n"),
    "8-bit CSI colour controls": (t) => t.split("\n").map((line) => line
      ? `\x9b31m${line}\x9b0m`
      : line).join("\n"),
    // Modern terminals make locations clickable with OSC 8. Those controls can wrap
    // any parser-significant line, and unlike colour they do not use CSI `...m`.
    "OSC 8 terminal hyperlinks": (t) => t.split("\n").map((line) => line
      ? `\x1b]8;;https://example.invalid/source\x1b\\${line}\x1b]8;;\x1b\\`
      : line).join("\n"),
    "BEL-terminated OSC 8 hyperlinks": (t) => t.split("\n").map((line) => line
      ? `\x1b]8;;file:///tmp/source\x07${line}\x1b]8;;\x07`
      : line).join("\n"),
    "8-bit OSC hyperlinks": (t) => t.split("\n").map((line) => line
      ? `\x9d8;;file:///tmp/source\x9c${line}\x9d8;;\x9c`
      : line).join("\n"),
    "no trailing newline": (t) => t.replace(/\n+$/, ""),
    "blank lines first": (t) => "\n\n\n" + t,
  };
  const changed = [];
  let checked = 0;
  for (const name of readdirSync(join(here, "fixtures"))) {
    const raw = readFileSync(join(here, "fixtures", name), "utf8");
    if (raw.includes("\r\n")) continue;
    // JSON intentionally omits private source ranges, whose raw offsets may move when
    // blank/progress lines are added. Every diagnostic field must remain exact, not
    // merely the parser name and failure count. Wrapper provenance is arrival metadata,
    // so adding another outer arrival layer may legitimately change it.
    const read = (t) => { try {
      const r = analyse(t);
      return r ? JSON.stringify({ tool: r.tool, summary: r.summary, failures: r.failures,
        clusters: r.clusters, others: r.others }) : "none";
    } catch { return "threw"; } };
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

// A headline a parser writes from a count, rather than copying the tool's, has to agree
// with it. Five of them said "1 errors" or "1 failures" whenever the count was one: a lone
// mypy line, a PHPUnit or rspec run whose tally was cut off, a TeamCity stream of one test.
try {
  const { EXTRACTORS } = await import("../src/index.js");
  const fx = (n) => readFileSync(join(here, "fixtures", n), "utf8");
  const teamcity = fx("phpunit_teamcity_fail.txt").split("\n");
  const one = {
    "a lone mypy line": [analyse("b.pyi:1:14: error: Incompatible types in assignment  [assignment]\n"), "1 error"],
    "PHPUnit with its tally cut off": [analyse(fx("phpunit_error_fail.txt").replace(/^Tests:.*\n/m, "")), "1 failure"],
    "rspec with its tally cut off": [analyse(fx("rspec_fail.txt")
      .replace(/^\d+ examples, \d+ failures\n/m, "")
      .replace(/  2\) [\s\S]*?(?=\nFinished)/, "")
      .replace(/^rspec .*exp claim\n/m, "")), "1 failure"],
    "a TeamCity stream of one test": [analyse([teamcity[0].replace("count='3'", "count='1'"), ...teamcity.slice(1, 6),
      teamcity.find((l) => l.startsWith("##teamcity[testSuiteFinished name='ArithmeticTest"))].join("\n")), "1 of 1 test failed"],
  };
  for (const [what, [r, summary]] of Object.entries(one)) {
    assert.equal(r?.failures.length, 1, `${what}: not one failure`);
    assert.equal(r.summary, summary, what);
  }
  // eslint without its tally, where a warning is counted beside the one error
  const eslint = EXTRACTORS.find((ex) => ex.name === "eslint");
  const lint = "/home/dev/js/messy.js\n  1:7  error  'unused' is assigned a value but never used  no-unused-vars\n" +
    "  4:10  warning  Empty block statement  no-empty\n";
  assert.equal(eslint.extract(lint).summary, "1 error — 1 warning hidden");
  console.log("  ok   a count of one takes a noun in the singular");
  pass++;
} catch (e) { console.log(`  FAIL singular counts\n       ${e.message}`); fail++; }

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
    // --tb=native prints a Python traceback inside pytest's own report, so the traceback
    // parser matches it the way it matches unittest's. Both match by design; pytest is
    // listed first and adds what python cannot see from the traceback alone - the test
    // names and the run's counts.
    "pytest_tb_native_fail.txt": ["pytest", "python"],
    // ruff's concise form and flake8's only output are the same shape - file, line,
    // column, code, message - so flake8 matches it by design. ruff is listed first and
    // wins on a marker flake8 never writes: the "[*] N fixable" note about its own --fix
    // option. A ruff run with nothing fixable in it really is indistinguishable, and
    // flake8 reads it identically anyway.
    "ruff_concise_fail.txt": ["ruff", "flake8"],
    // rubocop --format tap is a TAP document, and its failures are rubocop's offenses
    // written as comments under a `not ok` per file. The TAP reading is two failures named
    // after the files; rubocop is asked first, and reads the six offenses in them.
    "rubocop_tap_fail.txt": ["rubocop", "tap-text"],
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
    // Node's spec reporter prints a crashed test file's raw runtime exception before
    // its own roll-up. Both parsers see real output; node --test owns the shared source
    // range so the exception is presented once under the command that was run.
    "nodetest_reporter_spec_crash_fail.txt": ["node --test", "node"],
    "nodetest_reporter_spec_syntax_fail.txt": ["node --test", "node"],
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

// a clean run must not be mistaken for a failure
const CLEAN = "============ test session starts ============\ncollected 2 items\n\ntest_a.py ..    [100%]\n\n============ 2 passed in 0.01s ============\n";
try {
  const r = analyse(CLEAN);
  assert.ok(!r || r.failures.length === 0, "clean pytest run must yield no failures");
  console.log("  ok   clean run yields nothing");
  pass++;
} catch (e) { console.log(`  FAIL clean run\n       ${e.message}`); fail++; }

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
  // CI systems retry and concatenate a failed step. The visible diagnostics are
  // de-duplicated, so the headline must describe that same visible set rather than the
  // number of times the runner happened to print it.
  let checked = 0;
  for (const name of readdirSync(join(here, "fixtures"))) {
    const raw = fx(name);
    const once = analyse(raw);
    if (!once?.failures.length) continue;
    const retried = analyse(raw.replace(/\n*$/, "\n") + "\n" + raw);
    assert.equal(JSON.stringify(retried), JSON.stringify(once),
      `${name}: a byte-identical retry changed the public reading`);
    checked++;
  }
  assert.ok(checked >= 200, `only ${checked} retry pairs exercised`);
  const raw = fx("eslint_fail.txt").replace(/\n*$/, "");
  assert.equal(JSON.stringify(analyse([raw, raw, raw, raw].join("\n\n"))),
    JSON.stringify(analyse(raw)), "four identical attempts did not collapse recursively");
  console.log(`  ok   retry duplication changes none of ${checked} public readings`);
  pass++;
} catch (e) { console.log(`  FAIL duplicate headline counts\n       ${e.message}`); fail++; }

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

// A flag that changes how a diagnostic is printed must not change what is read from it.
try {
  const same = (a, b, what) => {
    const facts = (r) => r.failures.map((f) => [f.file, f.line, f.col, f.code, f.title]);
    const x = analyse(fx(a)), y = analyse(fx(b));
    assert.equal(y.tool, x.tool, `${what}: different tool`);
    assert.deepEqual(facts(y), facts(x), `${what}: different failures`);
  };
  same("tsc_plain_same_fail.txt", "tsc_pretty_fail.txt", "tsc --pretty");
  same("cargo_human_same_fail.txt", "cargo_short_fail.txt", "cargo --message-format=short");
  console.log("  ok   a printing flag does not change what is read");
  pass++;
} catch (e) { console.log(`  FAIL printing flags\n       ${e.message}`); fail++; }

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
