import { githubAnnotations, xmlAttributes, xmlText } from "../util.js";
const FAIL_RE = /^[^\S\n]*FAIL[^\S\n]+(.+?)[^\S\n]+>[^\S\n]+(.+?)[^\S\n]*$/;
// A suite that throws before any test is declared cannot be named after a test, so
// vitest lists it under "Failed Suites" with the file in brackets instead of a test
// name after a chevron. Reading only the chevron form meant a file that will not even
// import - one of the commonest ways a suite fails - fell through to the guess.
const SUITE_RE = /^[^\S\n]*FAIL[^\S\n]+(.+?)[^\S\n]+\[[^\S\n]*(.+?)[^\S\n]*\][^\S\n]*$/;
// vitest heads a file that failed to load with the file again in brackets:
// "FAIL  t/crash.test.js [ t/crash.test.js ]". go writes "FAIL <pkg> [build failed]" for
// a package that would not compile, and the same shape read that as a vitest suite named
// after a Go package - one failure more than the log holds whenever the two shared a log.
//
// What tells them apart is that vitest's bracket REPEATS the header, and go's does not.
// Asking instead whether the bracket looked like a filename - no spaces, one extension -
// dropped every suite under a directory with a space in its name: "FAIL  my tests/a.test.js
// [ my tests/a.test.js ]" came back as nothing, which is the mistake #94 fixed elsewhere.
// The header ENDS with the bracket rather than equalling it, because a workspace project
// badges the file first: "FAIL  |unit| my tests/a.test.js [ my tests/a.test.js ]".
function suiteOf(line) {
  const m = line.match(SUITE_RE);
  if (!m) return null;
  const head = m[1].trim(), inside = m[2].trim();
  return inside && head.endsWith(inside) ? m : null;
}
const LOC_RE = /^[^\S\n]*[❯>][^\S\n]+(.+?):(\d+):(\d+)[^\S\n]*$/;
const SEP_RE = /^[⎯─-╿\s]*(?:\[\d+\/\d+\])?[⎯─-╿\s]*$/;

// `--reporter=tap` and `--reporter=tap-flat`. Both are TAP 13 with a YAML block, but the
// dialect is vitest's own: tap.js reads node-tap, whose `at:` opens a map of fileName and
// lineNumber, while vitest writes `at: "path:line:col"` on one line and puts the class
// and the text under `error:`. Neither parser matched it, so a failing run came back as
// a single guess reading "error:" - no test named, no location, no count.
const TAP_VERSION_RE = /^TAP version \d+[^\S\n]*$/m;
const TAP_RESULT_RE = /^[^\S\n]*(not )?ok[^\S\n]+\d+[^\S\n]*-?[^\S\n]*(.*?)[^\S\n]*$/;
const TAP_YAML_OPEN_RE = /^[^\S\n]*---[^\S\n]*$/;
const TAP_YAML_END_RE = /^[^\S\n]*\.\.\.[^\S\n]*$/;
const TAP_AT_RE = /^[^\S\n]*at:[^\S\n]*"(.+):(\d+):(\d+)"[^\S\n]*$/;
const TAP_FIELD_RE = /^[^\S\n]*(name|message|actual|expected):[^\S\n]*"(.*)"[^\S\n]*$/;
// The nested reporter wraps a file's tests in a result of its own, opened with a brace.
// That is the file's roll-up; its members report themselves, and counting it as well
// would report one failing test as two.
const TAP_GROUP_RE = /\{[^\S\n]*$/;

/** vitest's own TAP dialect: the failures it names, and how many tests passed. */
function vitestTap(text) {
  if (!TAP_VERSION_RE.test(text)) return null;
  const lines = text.split("\n");
  const failures = [];
  let passed = 0, dialect = false;
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i].match(TAP_RESULT_RE);
    if (!head || TAP_GROUP_RE.test(lines[i])) continue;
    if (!head[1]) { passed++; continue; }
    if (!TAP_YAML_OPEN_RE.test(lines[i + 1] ?? "")) continue;
    let file, line, col, name, message;
    const compared = {};
    for (let j = i + 2; j < lines.length && !TAP_YAML_END_RE.test(lines[j]); j++) {
      const at = lines[j].match(TAP_AT_RE);
      if (at) { dialect = true; [, file, line, col] = at; continue; }
      const field = lines[j].match(TAP_FIELD_RE);
      if (field?.[1] === "name") name ??= field[2];
      else if (field?.[1] === "message") message ??= field[2];
      else if (field) compared[field[1]] ??= field[2];
    }
    if (!file && message === undefined) continue;
    // tap-flat names the test "file > test"; the pretty reporter titles it by the test
    // alone, and the file is already carried as the location.
    const title = (head[2] || "test").replace(/[^\S\n]*#[^\S\n]*time=.*$/, "").trim()
      .split(/[^\S\n]+>[^\S\n]+/).pop();
    failures.push({
      file, line: line ? +line : undefined, col: col ? +col : undefined,
      title, subject: title, severity: "error",
      // The pretty reporter prints the two values under the sentence; TAP carries them
      // as fields instead. They are the most useful part of an assertion failure, so
      // they are put back in the same notation rather than dropped.
      message: ([name, message].filter(Boolean).join(": ") || title) +
        (compared.expected !== undefined && compared.actual !== undefined
          ? `\n- ${compared.expected}\n+ ${compared.actual}` : ""),
    });
  }
  return dialect && failures.length ? { failures, passed } : null;
}

// --reporter=junit and --reporter=github-actions, neither of which was read: the JUnit
// document came back with no diagnosis at all, and the annotations fell through to the
// generic reader, which printed vitest's %0A-encoded diff back at you as one long line.
//
// Both shapes are written by other tools, so both are bounded by something vitest
// declares. The document names its own suite `vitest tests`. The annotation opens its
// title with the test file, which is the file the annotation already points at - so a
// title whose first segment is not that file is not vitest's.
// The document is cut out before it is read. A log can hold two JUnit reports - vitest's
// beside PHPUnit's or node's - and deciding on the whole log and then reading the whole
// log is not a bound: it hands vitest everybody else's test cases.
const VITEST_DOC_RE = /<testsuites\b[^>]*\bname="vitest tests"[^>]*>([\s\S]*?)<\/testsuites>/g;
const VITEST_SUITES = /<testsuites\b[^>]*\bname="vitest tests"/;
const JUNIT_CASE_RE = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
const JUNIT_FAILURE_RE = /<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/;
// vitest writes its frames with a pointer rather than the word "at".
const VITEST_FRAME = /^[^\S\n]*[❯>][^\S\n]+(.+?):(\d+):(\d+)[^\S\n]*$/;
const base = (p) => String(p ?? "").split(/[\\/]/).pop();
// A reporter that writes to a file says so and prints nothing else. The run failed, the
// answer exists, and the log holding only this line came back "could not identify a
// diagnostic" - when vitest had just said where to look.
const REPORT_WRITTEN = /^([A-Z][A-Z-]*) report written to (\S.*?)[^\S\n]*$/m;
// The diff a value comparison prints is part of the answer, and the pretty reporter's
// reading already keeps it. The machine reporters carry the same block, so it is read
// the same way - message first, then the values, without the "- Expected / + Received"
// headers that promise a diff and show none.
const DIFF_HEADER = /^[-+][^\S\n]*(?:Expected|Received):?[^\S\n]*$/;
function saidIn(body) {
  let message = "";
  const diff = [];
  for (const raw of body) {
    if (VITEST_FRAME.test(raw)) break;
    const l = raw.trim();
    if (!l) continue;
    if (!message) { message = l; continue; }
    if (/^[-+][^\S\n]*\S/.test(l) && !DIFF_HEADER.test(l)) diff.push(l);
  }
  return [message, ...diff.slice(0, 4)].join("\n");
}

/** The failures of a --reporter=junit document, or none. */
function vitestJunit(s) {
  if (!VITEST_SUITES.test(s)) return [];
  const out = [];
  const mine = [...s.matchAll(VITEST_DOC_RE)].map((d) => d[1]).join("\n");
  for (const test of mine.matchAll(JUNIT_CASE_RE)) {
    if (!test[2]) continue;
    const a = xmlAttributes(test[1]);
    const outcome = test[2].match(JUNIT_FAILURE_RE);
    if (!outcome) continue;
    const body = xmlText(outcome[3] ?? "").split("\n");
    let file = a.classname, line, col;
    for (const raw of body) {
      const at = raw.match(VITEST_FRAME);
      if (at) { file = at[1]; line = +at[2]; col = +at[3]; break; }
    }
    // The first line of the body is the message with its class in front of it, which is
    // what the pretty reporter prints; the attribute holds the same text without it.
    const message = saidIn(body) || xmlAttributes(outcome[2]).message || "";
    out.push({
      file, line, col, title: a.name, subject: a.name, severity: "error", message,
    });
  }
  return out;
}

/** The failures a --reporter=github-actions run annotated, or none. */
function vitestAnnotations(s) {
  if (!/^[^\S\n]*::error[^\S\n]/m.test(s)) return [];
  const out = [];
  for (const a of githubAnnotations(s)) {
    if (a.severity !== "error" || !a.props.title || !a.props.file) continue;
    // `title=test/cart.test.js > cart > totals an invoice` - the first segment is the
    // file the annotation already points at. Anything else is another tool's annotation.
    const parts = a.props.title.split(" > ");
    if (parts.length < 2 || base(parts[0]) !== base(a.props.file)) continue;
    const body = a.message.split("\n");
    let file = a.props.file, line = +a.props.line || undefined, col = +(a.props.column ?? a.props.col) || undefined;
    for (const raw of body) {
      const at = raw.match(VITEST_FRAME);
      if (at) { file = at[1]; line = +at[2]; col = +at[3]; break; }
    }
    const name = parts.slice(1).join(" > ");
    out.push({
      file, line, col, title: name, subject: name, severity: "error", message: saidIn(body),
    });
  }
  return out;
}

export default {
  name: "vitest",
  category: "test",
  commands: ["vitest"],
  detect: (s) => vitestTap(s) !== null || vitestJunit(s).length > 0 ||
    vitestAnnotations(s).length > 0 || REPORT_WRITTEN.test(s) ||
    /^[^\S\n]*RUN[^\S\n]+v\d/m.test(s) || /Failed (?:Tests|Suites) \d+/.test(s) ||
    FAIL_RE.test(s) || s.split("\n").some((l) => suiteOf(l) !== null),

  extract(s) {
    const lines = s.split("\n");
    const failures = [];
    let unloaded = 0;

    for (let i = 0; i < lines.length; i++) {
      const suite = suiteOf(lines[i]);
      const m = lines[i].match(FAIL_RE) ?? suite;
      if (!m) continue;
      // In the suite form both captures are the file; the failure is the file itself.
      const [, file, title] = suite ? [null, suite[2].trim(), suite[2].trim()] : m;

      // vitest writes the assertion on the line straight under the FAIL header - every
      // one of the blocks in the corpus has a gap of exactly one, separators aside.
      // Taking the first non-blank line however far away it was meant that when two
      // tools write into one pipe and the block comes back shredded, whatever landed in
      // between became this test's assertion.
      const MESSAGE_GAP = 3;
      let message = "", loc = null;
      const diff = [];
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j];
        if (FAIL_RE.test(l)) break;
        if (!message && j - i > MESSAGE_GAP) break;
        const lm = l.match(LOC_RE);
        if (lm) { loc = { file: lm[1], line: +lm[2], col: +lm[3] }; break; }
        if (!message && l.trim() && !SEP_RE.test(l)) { message = l.trim(); continue; }
        // vitest prints a "- Expected / + Received" diff; keep the values, drop the header
        // vitest labels its diff "- Expected:" / "+ Received:" - with a colon. Keeping
        // those headers without their values promises a diff and shows none.
        if (/^[^\S\n]*[-+][^\S\n]*\S/.test(l) && !/^[-+][^\S\n]*(Expected|Received):?[^\S\n]*$/.test(l.trim())) {
          diff.push(l.trim());
        }
      }
      if (!message) continue;
      if (suite) unloaded++;
      failures.push({
        file: loc?.file ?? file, line: loc?.line, col: loc?.col,
        title, subject: title, severity: "error", message: [message, ...diff.slice(0, 4)].join("\n"),
      });
    }

    // "Tests  no tests" is what vitest prints when a suite never got far enough to
    // declare one, and a headline of "no tests" over a real failure reads as though
    // nothing was wrong. The file tally is the one that says what happened.
    let summary;
    for (const l of lines) {
      const m = l.match(/^[^\S\n]*Tests[^\S\n]+(.+?)[^\S\n]*$/);
      if (m) { summary = m[1]; break; }
      const files = l.match(/^[^\S\n]*Test Files[^\S\n]+(.+?)[^\S\n]*$/);
      if (files) summary ??= `${files[1]} (no tests ran)`;
    }
    // A TAP run and a pretty run can share a log - `--reporter=tap --reporter=default`
    // is one command - and then the same test is described twice. What tells a second
    // rendering from a second run is the failure itself: same test, same line, same
    // column. The file is compared by its last segment, because TAP prints the absolute
    // path where the pretty reporter prints the one you typed.
    const tap = vitestTap(s);
    if (tap) {
      const seen = new Set(failures.map((f) =>
        `${String(f.file ?? "").split(/[\\/]/).pop()}\u0000${f.line}\u0000${f.col}\u0000${f.title}`));
      for (const f of tap.failures) {
        const key = `${String(f.file ?? "").split(/[\\/]/).pop()}\u0000${f.line}\u0000${f.col}\u0000${f.title}`;
        if (!seen.has(key)) { seen.add(key); failures.push(f); }
      }
      summary ??= `${failures.length} failed | ${tap.passed} passed (${failures.length + tap.passed})`;
    }
    // ...and the machine reporters, on the same terms: same test, same line, same
    // column is one rendering said twice, and the file is compared by its last segment
    // because they print the absolute path where the pretty reporter prints yours.
    const machine = [...vitestJunit(s), ...vitestAnnotations(s)];
    if (machine.length) {
      const seen = new Set(failures.map((f) =>
        `${base(f.file)}\u0000${f.line}\u0000${f.col}\u0000${f.title}`));
      for (const f of machine) {
        const key = `${base(f.file)}\u0000${f.line}\u0000${f.col}\u0000${f.title}`;
        if (!seen.has(key)) { seen.add(key); failures.push(f); }
      }
      // Neither reporter prints a tally line of its own.
      summary ??= `${failures.length} failed (${failures.length})`;
    }
    if (!failures.length) {
      // Nothing was read because there was nothing to read: the reporter wrote its
      // report to a file. Saying where is the whole of what this log supports, and it
      // is more than saying nothing.
      const wrote = s.match(REPORT_WRITTEN);
      if (!wrote) return null;
      return {
        tool: "vitest",
        // "a report was written" does not say anything went wrong, and the guarantees
        // suite rejects a headline that reads like nothing did.
        summary: `the run failed and its ${wrote[1]} report is not in this log`,
        failures: [{
          title: "report", label: "report", severity: "error",
          message: `vitest wrote its ${wrote[1]} report to ${wrote[2]}; this log holds none of what it said`,
        }],
      };
    }
    const files = s.match(/^[^\S\n]*Test Files[^\S\n]+(.+?)[^\S\n]*$/m);
    if (/^no tests$/.test(summary ?? "") && files) summary = `${files[1]} (no tests ran)`;
    // "Tests  1 failed (1)" counts tests, and a file that never loaded declared none - so
    // a log holding one of each was headlined "1 failed" over two failures. Say what the
    // test tally cannot see, unless the headline already says no tests ran at all.
    if (unloaded && summary && !/no tests ran/.test(summary)) {
      summary += ` — ${unloaded} file${unloaded > 1 ? "s" : ""} failed to load`;
    }
    return { tool: "vitest", summary, failures };
  },
};
