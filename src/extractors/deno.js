// `deno test` gathers its failures under an ERRORS banner:
//
//    ERRORS
//
//   invoice total => ./math_test.ts:4:6
//   error: AssertionError: Values are not equal.
//
//       [Diff] Actual / Expected
//
//   -   1049
//   +   1050
//
//     throw new AssertionError(message);
//           ^
//       at assertEquals (https://jsr.io/@std/assert/1.0.19/equals.ts:67:9)
//
//   FAILED | 1 passed | 2 failed (15ms)
//
// The header line carries the test name and its location together, which is all
// the location we need - the stack frames below it are inside the assert library.
const HEADER_RE = /^(\S.*?)[^\S\n]+=>[^\S\n]+(\S+?):(\d+):(\d+)[^\S\n]*$/;
const SUMMARY_RE = /^(?:FAILED|ok)[^\S\n]*\|[^\S\n]*(\d+)[^\S\n]+passed[^\S\n]*\|[^\S\n]*(\d+)[^\S\n]+failed/m;
const ERROR_RE = /^error:[^\S\n]*(.+)$/;
const DIFF_LABEL_RE = /^\[Diff\]/;
const THROW_RE = /^throw new |^\^+$/;
const MAX_MESSAGE_LINES = 4;

export default {
  name: "deno test",
  category: "test",
  commands: ["deno"],
  detect: (s) => /^[^\S\n]*ERRORS[^\S\n]*$/m.test(s) && SUMMARY_RE.test(s),

  extract(s) {
    const lines = s.split("\n");
    const failures = [];

    for (let i = 0; i < lines.length; i++) {
      const head = lines[i].match(HEADER_RE);
      if (!head) continue;

      // deno writes "error: <Class>: <message>" on the line straight under the header,
      // every time. Scanning forward for any line at all meant that when two tools write
      // into one pipe and the block comes back shredded, whatever landed in between
      // became this test's assertion - a clang diagnostic read as a deno failure. If the
      // error line is not there, this is not a block we can read.
      let at = i + 1;
      while (at < lines.length && !lines[at].trim()) at++;
      if (at >= lines.length || !ERROR_RE.test(lines[at].trim())) continue;

      const msg = [];
      for (let j = at; j < lines.length && !HEADER_RE.test(lines[j]); j++) {
        const t = lines[j].trim();
        if (!t || msg.length >= MAX_MESSAGE_LINES) continue;
        // the FAILURES roll-call and the final tally end the block
        if (/^FAILURES[^\S\n]*$/.test(t) || SUMMARY_RE.test(t) || /^error: Test failed[^\S\n]*$/.test(t)) break;
        if (/^at\s/.test(t) || DIFF_LABEL_RE.test(t) || THROW_RE.test(t)) continue;
        const err = t.match(ERROR_RE);
        msg.push(err ? err[1] : t);
      }
      if (!msg.length) continue;
      failures.push({
        file: head[2], line: +head[3], col: +head[4],
        title: head[1], subject: head[1], severity: "error", message: msg.join("\n"),
      });
    }

    if (!failures.length) return null;
    const m = s.match(SUMMARY_RE);
    return {
      tool: "deno test",
      summary: m ? `${m[2]} failed, ${m[1]} passed` : undefined,
      failures,
    };
  },
};
