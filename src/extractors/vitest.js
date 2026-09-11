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
// vitest's bracket holds a file; go's holds a phrase.
function suiteOf(line) {
  const m = line.match(SUITE_RE);
  return m && /^\S+\.\w+$/.test(m[2].trim()) ? m : null;
}
const LOC_RE = /^[^\S\n]*[❯>][^\S\n]+(.+?):(\d+):(\d+)[^\S\n]*$/;
const SEP_RE = /^[⎯─-╿\s]*(?:\[\d+\/\d+\])?[⎯─-╿\s]*$/;

export default {
  name: "vitest",
  category: "test",
  commands: ["vitest"],
  detect: (s) => /^[^\S\n]*RUN[^\S\n]+v\d/m.test(s) || /Failed (?:Tests|Suites) \d+/.test(s) ||
    FAIL_RE.test(s) || s.split("\n").some((l) => suiteOf(l) !== null),

  extract(s) {
    const lines = s.split("\n");
    const failures = [];

    for (let i = 0; i < lines.length; i++) {
      const suite = suiteOf(lines[i]);
      const m = lines[i].match(FAIL_RE) ?? suite;
      if (!m) continue;
      // In the suite form both captures are the file; the failure is the file itself.
      const [, file, title] = suite ? [null, suite[1], suite[1]] : m;

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
    if (!failures.length) return null;
    const files = s.match(/^[^\S\n]*Test Files[^\S\n]+(.+?)[^\S\n]*$/m);
    if (/^no tests$/.test(summary ?? "") && files) summary = `${files[1]} (no tests ran)`;
    return { tool: "vitest", summary, failures };
  },
};
