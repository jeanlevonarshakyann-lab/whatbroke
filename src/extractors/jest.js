import { githubAnnotations } from "../util.js";
// With multiple jest projects the display name comes first: "FAIL jsdom src/a.js".
// Take the last token, which is always the path.
const FILE_RE = /^[^\S\n]*(?:FAIL|PASS)[^\S\n]+(?:\S+[^\S\n]+)*?(\S+)[^\S\n]*$/;
// jest uses the same bullet for config complaints as for failed tests
const TEST_RE = /^[^\S\n]*●[^\S\n]+(?!Console|Validation Warning|Deprecation Warning|Invalid testPattern)(.+?)[^\S\n]*$/;
const AT_RE = /^[^\S\n]+at .*?\(?([^\s()]+):(\d+):(\d+)\)?[^\S\n]*$/;
// --reporters=github-actions writes one workflow annotation per failure and then repeats
// the whole failure inside a ::group::. Neither was read: the tally jest's own reporter
// prints is not there, and the repeated block is indented under the group, so a run with
// two failing tests came back with no diagnosis at all.
//
// The annotation shape carries no tool name and biome, eslint and yamllint write it too.
// What marks these as jest's is the group heading, which is jest's own wording.
const JEST_GROUP = /^[^\S\n]*::group::Errors thrown in[^\S\n]+(.+?)[^\S\n]*$/;
// Any workflow command at all. The group block is the one place jest's failure text
// appears without a tally line after it, so without this the last block's body runs to
// the end of the log and takes the next tool's frames with it.
const WORKFLOW_LINE = /^[^\S\n]*::[a-z][\w-]*(?:[^\S\n][^\n]*?)?::/;
// Inside the annotation the frame is written the way jest writes it everywhere else.
const FRAME_IN_MESSAGE = /^[^\S\n]*at .*?\(?([^\s()]+):(\d+):(\d+)\)?[^\S\n]*$/;

/** The first few meaningful lines of a failure block: the matcher summary and what it
 *  expected, without the source frame, the caret or the diff's own bookkeeping. */
function diagnosis(body) {
  const msg = [];
  for (const l of body) {
    const t = l.trim();
    if (!t) continue;
    if (/^\d+[^\S\n]*\|/.test(t) || /^>[^\S\n]*\d+[^\S\n]*\|/.test(t) || /^\|/.test(t) || /^\^+$/.test(t)) continue;
    if (/^at /.test(t)) continue;
    // snapshot diffs open with a pair of count headers - "- Snapshot  - 3" and
    // "+ Received  + 3". Keeping those spends the budget before the actual diff.
    if (/^[-+][^\S\n]*(Snapshot|Received)[^\S\n]+[-+][^\S\n]*\d+[^\S\n]*$/.test(t)) continue;
    if (/^@@ [-+\d, ]+ @@$/.test(t)) continue;                   // diff hunk header
    // "Snapshot name: `<the test name> 1`" restates the title we already print
    if (/^Snapshot name:/.test(t)) continue;
    msg.push(t);
    if (msg.length >= 3) break;
  }
  return msg;
}

/** The failures a `--reporters=github-actions` run annotated, or none.
 *
 *  The annotation shape carries no tool name, and a log can hold two tools' annotations
 *  at once - biome's beside jest's. Deciding on the whole log and then reading the whole
 *  log is not a bound, so every annotation has to name a file jest said it threw in. */
function annotated(s) {
  const mine = new Set();
  for (const line of s.split("\n")) {
    const g = line.match(JEST_GROUP);
    if (g) mine.add(g[1].split(/[\\/]/).pop());
  }
  if (!mine.size) return [];
  const out = [];
  for (const a of githubAnnotations(s)) {
    if (a.severity !== "error" || !a.props.title || !a.props.file) continue;
    if (!mine.has(a.props.file.split(/[\\/]/).pop())) continue;
    // ...and vitest writes this shape too, with the same basenames whenever the two
    // suites name their files alike. What tells them apart is the title: vitest opens
    // it with the test file it is already pointing at, and jest never does.
    const [head] = a.props.title.split(" > ");
    if (head !== a.props.title && head.split(/[\\/]/).pop() === a.props.file.split(/[\\/]/).pop()) continue;
    const body = a.message.split("\n");
    const msg = diagnosis(body);
    if (!msg.length) continue;
    // The annotation points at the whole file and the line the test opens on; the frame
    // inside it points at the assertion that actually threw, which is what jest's own
    // reporter shows and what the other formats of the same run agree on.
    let loc = null;
    for (const l of body) {
      const am = l.match(FRAME_IN_MESSAGE);
      if (am && !/node_modules|node:internal/.test(am[1])) loc = { file: am[1], line: +am[2], col: +am[3] };
    }
    out.push({
      file: loc?.file ?? a.props.file, line: loc?.line ?? (+a.props.line || undefined), col: loc?.col,
      title: a.props.title, subject: a.props.title, severity: "error", message: msg.join("\n"),
    });
  }
  return out;
}

export default {
  name: "jest",
  category: "test",
  commands: ["jest"],
  detect: (s) => /^Tests:[^\S\n]+\d/m.test(s) || (/^[^\S\n]*●[^\S\n]+/m.test(s) && /^[^\S\n]*FAIL[^\S\n]+/m.test(s)) ||
    annotated(s).length > 0,

  extract(s) {
    const lines = s.split("\n");
    const failures = [];
    let file = null;

    for (let i = 0; i < lines.length; i++) {
      const fm = lines[i].match(FILE_RE);
      if (fm) { file = fm[1].replace(/^\.\//, ""); continue; }
      const tm = lines[i].match(TEST_RE);
      if (!tm) continue;

      const body = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        if (TEST_RE.test(lines[j]) || FILE_RE.test(lines[j]) || /^Test Suites:/.test(lines[j])) break;
        if (WORKFLOW_LINE.test(lines[j])) break;
        body.push(lines[j]);
      }

      // first meaningful line is the matcher summary; keep Expected/Received too
      const msg = diagnosis(body);

      // location: last "at ..." frame that points at a real file
      let loc = null;
      for (const l of body) {
        const am = l.match(AT_RE);
        if (am && !/node_modules|node:internal/.test(am[1])) loc = { file: am[1], line: +am[2], col: +am[3] };
      }

      if (!msg.length) continue;
      failures.push({
        file: loc?.file ?? file, line: loc?.line, col: loc?.col,
        title: tm[1], subject: tm[1], severity: "error", message: msg.join("\n"),
      });
      i = j - 1;
    }

    // When a suite throws before any test runs, jest's tally reads "Tests: 0 total" -
    // and a headline of "0 total" over a real failure reads as though nothing happened.
    // The suite tally is the one that says what went wrong in that case.
    const tests = s.match(/^Tests:[^\S\n]+(.+?)[^\S\n]*$/m);
    const suites = s.match(/^Test Suites:[^\S\n]+(.+?)[^\S\n]*$/m);
    const sm = /^0 total$/.test(tests?.[1] ?? "") && suites ? [null, `${suites[1]} (no tests ran)`] : tests;

    // ...and the same failures as the GitHub reporter annotated them. It repeats each
    // one inside a ::group::, so a run read from the group blocks would already have
    // them; a failure read twice is read once.
    const said = new Set(failures.map((f) => [f.subject, f.file, f.line].join("\u0000")));
    for (const f of annotated(s)) {
      const key = [f.subject, f.file, f.line].join("\u0000");
      if (said.has(key)) continue;
      // A group block whose frame was cut off - by a truncated log, which is exactly
      // when this reporter's two copies stop agreeing - carries the test's name and no
      // location at all. That is the same failure as the annotation naming it, not a
      // second one, so the annotation completes it rather than standing beside it.
      const partial = failures.find((q) => q.subject === f.subject && q.line === undefined);
      if (partial) {
        partial.file = f.file; partial.line = f.line; partial.col = f.col;
        said.add(key);
        continue;
      }
      said.add(key);
      failures.push(f);
    }

    if (!failures.length) return null;
    const n = failures.length;
    return {
      tool: "jest",
      // This reporter prints no tally of its own, so the count is what was annotated.
      summary: sm?.[1] ?? `${n} test${n === 1 ? "" : "s"} failed`,
      failures,
    };
  },
};
