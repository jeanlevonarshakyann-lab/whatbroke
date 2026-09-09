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
const HEADER_RE = /^(\S.*?)\s+=>\s+(\S+?):(\d+):(\d+)\s*$/;
const SUMMARY_RE = /^(?:FAILED|ok)\s*\|\s*(\d+)\s+passed\s*\|\s*(\d+)\s+failed/m;
const ERROR_RE = /^error:\s*(.+)$/;
const DIFF_LABEL_RE = /^\[Diff\]/;
const THROW_RE = /^throw new |^\^+$/;
const MAX_MESSAGE_LINES = 4;

export default {
  name: "deno test",
  detect: (s) => /^\s*ERRORS\s*$/m.test(s) && SUMMARY_RE.test(s),

  extract(s) {
    const lines = s.split("\n");
    const failures = [];

    for (let i = 0; i < lines.length; i++) {
      const head = lines[i].match(HEADER_RE);
      if (!head) continue;

      const msg = [];
      for (let j = i + 1; j < lines.length && !HEADER_RE.test(lines[j]); j++) {
        const t = lines[j].trim();
        if (!t || msg.length >= MAX_MESSAGE_LINES) continue;
        // the FAILURES roll-call and the final tally end the block
        if (/^FAILURES\s*$/.test(t) || SUMMARY_RE.test(t) || /^error: Test failed\s*$/.test(t)) break;
        if (/^at\s/.test(t) || DIFF_LABEL_RE.test(t) || THROW_RE.test(t)) continue;
        const err = t.match(ERROR_RE);
        msg.push(err ? err[1] : t);
      }
      if (!msg.length) continue;
      failures.push({
        file: head[2], line: +head[3], col: +head[4],
        title: head[1], message: msg.join("\n"),
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
