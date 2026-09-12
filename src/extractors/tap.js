// node-tap emits TAP 14: a numbered result line, then a YAML block giving the comparison
// and where it happened.
//
//   not ok 1 - totals an invoice
//     ---
//     compare: ===
//     at:
//       fileName: taptest/sum.test.cjs
//       lineNumber: 2
//       columnNumber: 3
//     ...
//
// `node --test` writes TAP too and has its own parser; what tells them apart is the
// version line, which node does not emit, and node's YAML uses `failureType` and
// `location` where tap uses `at:` with a nested fileName.
const VERSION_RE = /^TAP version \d+[^\S\n]*$/m;
const NOT_OK_RE = /^[^\S\n]*not ok[^\S\n]+(\d+)[^\S\n]*-?[^\S\n]*(.*?)[^\S\n]*$/;
const AT_RE = /^[^\S\n]*at:[^\S\n]*$/;
const FIELD_RE = /^[^\S\n]*(fileName|lineNumber|columnNumber|found|wanted|compare|stack):[^\S\n]*(.*)$/;
// tap writes the values as a unified diff rather than as found/wanted fields.
const DIFF_RE = /^[^\S\n]*diff:[^\S\n]*\|[^\S\n]*$/;
const DIFF_VALUE_RE = /^[^\S\n]*([-+])(?!--|\+\+)(\S.*?)[^\S\n]*$/;
// and echoes the failing line under a `source:` block, marking it with --^
const SOURCE_RE = /^[^\S\n]*source:[^\S\n]*\|[^\S\n]*$/;
const MARKER_RE = /^[^\S\n]*-+\^/;
const END_RE = /^[^\S\n]*\.\.\.[^\S\n]*$/;
// A subtest's own roll-up repeats a failure that its members already reported.
const SUBTEST_RE = /^[^\S\n]*not ok[^\S\n]+\d+[^\S\n]*-[^\S\n]*\S+\.[cm]?[jt]s\b/;

/** Is there a YAML block under this result line, before the next TAP statement? */
function hasYaml(lines, i) {
  for (let j = i + 1; j < lines.length; j++) {
    if (!lines[j].trim()) continue;
    if (NOT_OK_RE.test(lines[j]) || /^[^\S\n]*ok[^\S\n]+\d+\b/.test(lines[j])) return false;
    return /^[^\S\n]*---[^\S\n]*$/.test(lines[j]);
  }
  return false;
}

export default {
  name: "tap",
  category: "test",
  commands: ["tap"],

  // Both emit a version line - I assumed node did not, and it does - so what tells them
  // apart is the YAML underneath: node --test writes `failureType` and a flat `location`,
  // tap writes an `at:` block with a nested fileName.
  //
  // The test is for tap's shape and NOT against node's. Refusing when node's marker
  // appears anywhere was the obvious move and the wrong one: in a log holding both, tap
  // declined and its failures were lost entirely. Each block is checked instead.
  detect: (s) => VERSION_RE.test(s) &&
    /^[^\S\n]*at:[^\S\n]*$/m.test(s) &&
    s.split("\n").some((l) => NOT_OK_RE.test(l)),

  extract(s) {
    const lines = s.split("\n");
    const failures = [];

    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(NOT_OK_RE);
      if (!m) continue;
      // The line naming a test FILE is tap reporting that the file had failures in it,
      // which its own members have already said.
      if (SUBTEST_RE.test(lines[i])) continue;

      // A result with no YAML block under it is bare TAP - TAP 12, what `mocha
      // --reporter tap` and Test::More emit - and this parser has nothing to read from
      // it. Taking those anyway produced a failure with no location at all, and in a log
      // holding both dialects it reported the bare ones twice: once locationless here,
      // once properly by the parser that can read them.
      if (!hasYaml(lines, i)) continue;

      // node --test's own blocks sit in the same log when a job ran both. They carry
      // `failureType`, which tap never writes, and node's parser reads them.
      let nodes = false;
      let deno = false;
      for (let j = i + 1; j < lines.length && j <= i + 40; j++) {
        if (NOT_OK_RE.test(lines[j]) || END_RE.test(lines[j])) break;
        if (/^[^\S\n]*failureType:/.test(lines[j])) { nodes = true; break; }
        // Deno's TAP reporter serializes its failure as JSON inside the YAML block.
        // Deno's parser decodes it; treating the `not ok` line as an ordinary tap
        // failure reports the same test twice whenever both reporters share a log.
        if (/^[^\S\n]*\{.*"severity"\s*:\s*"fail".*\}[^\S\n]*$/.test(lines[j])) {
          deno = true; break;
        }
      }
      if (nodes || deno) continue;

      const field = {};
      const diff = [];
      let stmt;
      let inAt = false, inDiff = false, inSource = false;
      for (let j = i + 1; j < lines.length && j <= i + 40; j++) {
        if (NOT_OK_RE.test(lines[j]) || END_RE.test(lines[j])) break;
        if (AT_RE.test(lines[j])) { inAt = true; continue; }
        if (DIFF_RE.test(lines[j])) { inDiff = true; inSource = false; continue; }
        if (SOURCE_RE.test(lines[j])) { inSource = true; inDiff = false; continue; }
        if (inDiff) {
          const d = lines[j].match(DIFF_VALUE_RE);
          if (d && diff.length < 4) { diff.push(`${d[1]}${d[2]}`); continue; }
        }
        if (inSource) {
          // the marked line is the one above the --^ pointer
          if (MARKER_RE.test(lines[j])) { stmt ??= lines[j - 1]?.trim(); continue; }
          continue;
        }
        const f = lines[j].match(FIELD_RE);
        if (!f) continue;
        // fileName appears both inside `at:` and inside a stack dump; the first wins
        if (field[f[1]] === undefined) field[f[1]] = f[2].trim().replace(/^["']|["']$/g, "");
        if (inAt && f[1] === "columnNumber") inAt = false;
      }

      failures.push({
        file: field.fileName || undefined,
        line: field.lineNumber ? +field.lineNumber : undefined,
        col: field.columnNumber ? +field.columnNumber : undefined,
        title: m[2] || `test ${m[1]}`,
        subject: m[2] || `test ${m[1]}`,
        severity: "error",
        stmt,
        message: diff.length
          ? diff.join("\n")
          : (field.found !== undefined && field.wanted !== undefined
              ? `expected ${field.wanted}, got ${field.found}`
              : (m[2] || `test ${m[1]}`)),
      });
    }

    if (!failures.length) return null;
    // The top-level plan counts test FILES, not assertions, so "2 failing of 1" is what
    // pairing them produces. The count of what failed stands on its own.
    const n = failures.length;
    return { tool: "tap", summary: `${n} failing`, failures };
  },
};
