// `bun test`:
//
//   (fail) suite > name > should do the thing [3.10ms]
//   274 |         expect(fn(input)).toEqual(expected);
//                                   ^
//   error: expect(received).toEqual(expected)
//
//   - { "path": "/" }
//   + false
//
//   - Expected  - 4
//   + Received  + 1
//
//         at <anonymous> (/abs/path/src/index.spec.ts:274:27)
//
// Note bun writes "error:" at the start of a line, which the cargo parser also
// looks for - so this must be registered ahead of it.
const FAIL_RE = /^\(fail\)\s+(.+?)(?:\s+\[[\d.]+m?s\])?\s*$/;
const ERROR_RE = /^error:\s*(.+)$/;
const AT_RE = /^\s*at\s+.*?\((.+?):(\d+):(\d+)\)\s*$/;
const SOURCE_RE = /^\s*\d+\s*\|/;              // bun's echoed source context
const CARET_RE = /^\s*\^+\s*$/;
const DIFF_COUNT_RE = /^[-+]\s*(Expected|Received)\s+[-+]\s*\d+\s*$/;
const MAX_MESSAGE_LINES = 4;

export default {
  name: "bun test",
  detect: (s) => /^\(fail\)\s+/m.test(s) &&
    (/^Ran \d+ tests? across/m.test(s) || /^\s*\d+ fail\s*$/m.test(s)),

  extract(s) {
    const lines = s.split("\n");
    const failures = [];

    for (let i = 0; i < lines.length; i++) {
      const head = lines[i].match(FAIL_RE);
      if (!head) continue;

      let file, line, col;
      const msg = [];
      for (let j = i + 1; j < lines.length && !FAIL_RE.test(lines[j]); j++) {
        const at = lines[j].match(AT_RE);
        if (at) { if (!file) { file = at[1]; line = +at[2]; col = +at[3]; } continue; }
        const t = lines[j].trim();
        if (!t || msg.length >= MAX_MESSAGE_LINES) continue;
        // the echoed source, its caret, and the diff's own tallies are not the message
        if (SOURCE_RE.test(lines[j]) || CARET_RE.test(lines[j]) || DIFF_COUNT_RE.test(t)) continue;
        const err = t.match(ERROR_RE);
        msg.push(err ? err[1] : t);
      }
      if (!msg.length) continue;
      failures.push({ file, line, col, title: head[1], message: msg.join("\n") });
    }

    if (!failures.length) return null;

    const num = (k) => {
      const m = s.match(new RegExp(String.raw`^\s*(\d+)\s+${k}\s*$`, "m"));
      return m ? +m[1] : null;
    };
    const [failed, passed] = [num("fail"), num("pass")];
    const bits = [];
    if (failed) bits.push(`${failed} fail`);
    if (passed) bits.push(`${passed} pass`);

    return { tool: "bun test", summary: bits.length ? bits.join(", ") : undefined, failures };
  },
};
