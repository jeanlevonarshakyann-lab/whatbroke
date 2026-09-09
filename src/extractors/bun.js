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
const FAIL_RE = /^\(fail\)[^\S\n]+(.+?)(?:[^\S\n]+\[[\d.]+m?s\])?[^\S\n]*$/;
const ERROR_RE = /^error:[^\S\n]*(.+)$/;
const AT_RE = /^[^\S\n]*at[^\S\n]+.*?\((.+?):(\d+):(\d+)\)[^\S\n]*$/;
const SOURCE_RE = /^[^\S\n]*\d+[^\S\n]*\|/;              // bun's echoed source context
const CARET_RE = /^[^\S\n]*\^+[^\S\n]*$/;
const DIFF_COUNT_RE = /^[-+][^\S\n]*(Expected|Received)[^\S\n]+[-+][^\S\n]*\d+[^\S\n]*$/;
const MAX_MESSAGE_LINES = 4;

export default {
  name: "bun test",
  category: "test",
  commands: ["bun"],
  detect: (s) => /^\(fail\)[^\S\n]+/m.test(s) &&
    (/^Ran \d+ tests? across/m.test(s) || /^[^\S\n]*\d+ fail[^\S\n]*$/m.test(s)),

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
      failures.push({ file, line, col, title: head[1], subject: head[1], severity: "error", message: msg.join("\n") });
    }

    if (!failures.length) return null;

    const num = (k) => {
      const m = s.match(new RegExp(String.raw`^[^\S\n]*(\d+)[^\S\n]+${k}[^\S\n]*$`, "m"));
      return m ? +m[1] : null;
    };
    const [failed, passed] = [num("fail"), num("pass")];
    const bits = [];
    if (failed) bits.push(`${failed} fail`);
    if (passed) bits.push(`${passed} pass`);

    return { tool: "bun test", summary: bits.length ? bits.join(", ") : undefined, failures };
  },
};
