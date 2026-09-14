// swc reports through miette, the Rust diagnostic renderer: the message on a line led by
// a lozenge, the location in a bracket beneath it, then the source in a drawn frame.
//
//     x Expression expected
//      ,-[swcbad.js:1:1]
//    1 | const x = ;
//      :           ^
//      `----
//
// The bracket is where the frame starts - the first line it draws, at column 1 - and not
// where the error is: that is the caret, under the semicolon in column 11. With context
// lines drawn above the error the bracket's line is wrong as well, so both come from the
// caret and the numbered line above it. miette draws a tab as spaces, so on a line indented
// with tabs the caret's column is where it was drawn rather than a count of characters.
//
//   Caused by:
//       Syntax Error
//   Error: Failed to compile 1 file with swc.
//
// The last line is the tally and says nothing; reading it - which is what happened
// before, under node's name - lost both the message and the location.
import { withSource } from "../ownership.js";

const MESSAGE_RE = /^[^\S\n]*[x×✗][^\S\n]+(\S.*?)[^\S\n]*$/;
const AT_RE = /^[^\S\n]*,-\[(.+?):(\d+):(\d+)\][^\S\n]*$/;
const SOURCE_RE = /^[^\S\n]*(\d+)[^\S\n]*\|[^\S\n]?(.*)$/;
// Under a numbered line: the gutter, then blanks, then what marks the span - `^` in the
// ASCII drawing a pipe gets, the underline or its tick in a terminal's.
const MARK_RE = /^([^\S\n]*[:|\u2502\u250a\u00b7][^\S\n]?)([^\S\n]*)[\^\u2500\u252c]/;
const FRAME_END_RE = /^[^\S\n]*(?:`-|\u2570\u2500)/;
const TALLY_RE = /^Error:[^\S\n]+Failed to compile \d+ files? with swc\.?[^\S\n]*$/m;

export default {
  name: "swc",
  // Strings a log has to hold for this parser to read anything from it - see src/router.js.
  signals: ["with swc"],
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

      let stmt, line = +at[2], col, end = i + 2;
      for (let j = i + 2; j < lines.length && j <= i + 12 && !FRAME_END_RE.test(lines[j]); j++) {
        const src = lines[j].match(SOURCE_RE);
        const mark = src && lines[j + 1]?.match(MARK_RE);
        if (!mark) continue;
        // the source text starts where the gutter ends, and the mark lines up under it
        const gutter = lines[j].length - src[2].length;
        if (mark[1].length !== gutter) continue;
        line = +src[1];
        col = mark[2].length + 1;
        stmt = src[2].trim();
        end = j + 2;
        break;
      }
      // The message, its location, and the source line it points at, down to the caret.
      failures.push(withSource({
        file: at[1], line, col,
        title: "syntax error", label: "syntax error", severity: "error",
        message: m[1], stmt,
      }, i, end));
      i += 1;
    }
    if (!failures.length) return null;
    const n = failures.length;
    return { tool: "swc", summary: n > 1 ? `${n} errors` : undefined, failures };
  },
};
