// swc reports through miette, the Rust diagnostic renderer: the message on a line led by
// a lozenge, the location in a bracket beneath it, then the source in a drawn frame.
//
//     x Expression expected
//      ,-[swcbad.js:1:1]
//    1 | const x = ;
//      :           ^
//      `----
//
//   Caused by:
//       Syntax Error
//   Error: Failed to compile 1 file with swc.
//
// The last line is the tally and says nothing; reading it - which is what happened
// before, under node's name - lost both the message and the location.
const MESSAGE_RE = /^[^\S\n]*[x×✗][^\S\n]+(\S.*?)[^\S\n]*$/;
const AT_RE = /^[^\S\n]*,-\[(.+?):(\d+):(\d+)\][^\S\n]*$/;
const SOURCE_RE = /^[^\S\n]*(\d+)[^\S\n]*\|[^\S\n]?(.*)$/;
const TALLY_RE = /^Error:[^\S\n]+Failed to compile \d+ files? with swc\.?[^\S\n]*$/m;

export default {
  name: "swc",
  category: "compile",
  commands: ["swc", "spack"],

  // The tally names the tool outright. The frame alone is miette's and is drawn by other
  // Rust tools too, so it is not enough on its own.
  detect: (s) => TALLY_RE.test(s),

  extract(s) {
    const lines = s.split("\n");
    const failures = [];
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(MESSAGE_RE);
      if (!m) continue;
      // The location is the next line, always: miette draws the bracket directly under
      // the message it belongs to.
      const at = lines[i + 1]?.match(AT_RE);
      if (!at) continue;

      let stmt;
      for (let j = i + 2; j < lines.length && j <= i + 8; j++) {
        const src = lines[j].match(SOURCE_RE);
        if (src && +src[1] === +at[2]) { stmt = src[2].trim(); break; }
      }
      failures.push({
        file: at[1], line: +at[2], col: +at[3],
        title: "syntax error", label: "syntax error", severity: "error",
        message: m[1], stmt,
      });
      i += 1;
    }
    if (!failures.length) return null;
    const n = failures.length;
    return { tool: "swc", summary: n > 1 ? `${n} errors` : undefined, failures };
  },
};
