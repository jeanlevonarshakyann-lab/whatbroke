// sass draws its diagnostics in a box and puts the location at the foot of it:
//
//   Error: Undefined variable.
//     ╷
//   2 │   color: $undefined-var;
//     │          ^^^^^^^^^^^^^^
//     ╵
//     bad.scss 2:10  root stylesheet
//
// The message is on the first line and the file, line and column are on the last, which
// is why reading only the first line found the problem and never where it was.
//
// That is one of the shapes the box takes. Where the terminal cannot draw it, or when asked
// with --no-unicode, sass draws it in ASCII - `,` for the cap, `|` for the gutter, `'` to
// close it - and every run in that mode read as nothing:
//
//   Error: Undefined variable.
//     ,
//   2 |   color: $undefined-var;
//     |          ^^^^^^^^^^^^^^
//     '
//     bad.scss 2:10  root stylesheet
//
// An error about two places draws both, under a heading naming each file where they are in
// different ones, and marks the place the error is about with ^^^ and the other with ━━━,
// or === in ASCII. A module loaded twice points at its second load; the first line in the
// box is the first load:
//
//   Error: Module loop: this module is already being loaded.
//     ┌──> cross/_b.scss
//   1 │ @use "a";
//     │ ^^^^^^^^ new load
//     ╵
//     ┌──> cross/loop.scss
//   1 │ @use "a";
//     │ ━━━━━━━━ original load
//     ╵
//     cross/_b.scss 1:1    @use
//     cross/loop.scss 1:1  root stylesheet
//
// And a deprecation made fatal says why it is an error before it draws anything. What every
// one of these ends with is the trace, whose last frame is always `root stylesheet`.
import { withSource } from "../ownership.js";
import { counted } from "../util.js";

const HEAD_RE = /^(Error|Warning|WARNING|DEPRECATION WARNING(?:[^\S\n]+\[[\w-]+\])?)(?:[^\S\n]+on line \d+.*)?:[^\S\n]*(.*)$/;
// "  bad.scss 2:10  root stylesheet" - the trailing phrase names the enclosing rule.
const WHERE_RE = /^[^\S\n]+(\S.*?)[^\S\n]+(\d+):(\d+)[^\S\n]*(?:[^\S\n]{2,}(.*))?$/;
// esbuild and vite draw a gutter with the same "│", so that rune alone identifies nothing -
// and esbuild closes its box with "╵" as well. What it never writes is the opening cap,
// which sass puts above every box it draws in Unicode.
const BOX_CAP_RE = /^[^\S\n]*╷[^\S\n]*$/;
// Where a box opens: its cap, or the heading naming the file a part of it is in.
const OPEN_RE = /^[^\S\n]*(?:[╷,]|┌──>[^\S\n]*\S.*|,-->[^\S\n]*\S.*)[^\S\n]*$/;
const CLOSE_RE = /^[^\S\n]*[╵'][^\S\n]*$/;
const SOURCE_RE = /^[^\S\n]*(\d+)[^\S\n]*[│|][^\S\n]?(.*)$/;
// Under a source line: the gutter, then what marks the span - ^ for the place the error is
// about, ━ or = for the one it is related to.
const MARK_RE = /^[^\S\n]*[│|][^\S\n]*([\^━=])/;
const GAP_RE = /^[^\S\n]*[│|┆:][^\S\n]*$/;
const ROOT = "root stylesheet";
// How far a diagnostic reaches before its trace. A fatal deprecation says why it is fatal
// and where to read more first, and a deprecation warning suggests what to write instead.
const MAX_BLOCK = 40;

/** Lines i onward read as one sass diagnostic: where it ends, where it is, and the source
 *  line it is about - or null when what follows the heading is not sass's. */
function diagnostic(lines, i) {
  let box = false, cap = false, where = null, stmt, first, last, end = i + 1;
  for (let j = i + 1; j < lines.length && j <= i + MAX_BLOCK; j++) {
    const line = lines[j];
    if (HEAD_RE.test(line)) break;
    // A frame is indented and ends in a line and column; a paragraph above the box starts
    // at the margin, and a numbered source line is the box's.
    const w = SOURCE_RE.test(line) ? null : line.match(WHERE_RE);
    if (w) {
      // The trace is the last of the block, innermost frame first.
      where ??= { file: w[1], line: +w[2], col: +w[3], frames: [] };
      where.frames.push((w[4] ?? "").trim());
      end = j + 1;
      continue;
    }
    if (where) break;
    if (OPEN_RE.test(line)) {
      box = true;
      if (j <= i + 2 && BOX_CAP_RE.test(line)) cap = true;
      end = j + 1;
      continue;
    }
    if (!box) continue;
    const src = line.match(SOURCE_RE);
    if (src) { last = src[2].trim(); first ??= last; end = j + 1; continue; }
    const mark = line.match(MARK_RE);
    if (mark) { if (mark[1] === "^" && stmt === undefined) stmt = last; end = j + 1; continue; }
    if (CLOSE_RE.test(line) || GAP_RE.test(line)) { end = j + 1; continue; }
  }
  // Unicode's cap directly under the heading is sass's; so is a trace that ends where every
  // sass trace does. Anything else under an "Error:" is somebody else's.
  if (!cap && where?.frames.at(-1) !== ROOT) return null;
  return { end, where, stmt: stmt ?? first };
}

export default {
  name: "sass",
  // Strings a log has to hold for this parser to read anything from it - see src/router.js.
  signals: ["╷", ROOT],
  category: "compile",
  commands: ["sass", "scss", "node-sass"],

  // A heading, and under it either sass's own Unicode cap or a trace ending in the root
  // stylesheet, which keeps "Error: ..." from claiming another tool's line.
  detect: (s) => {
    const lines = s.split("\n");
    return lines.some((l, i) => HEAD_RE.test(l) && diagnostic(lines, i) !== null);
  },

  extract(s) {
    const lines = s.split("\n");
    const failures = [];
    let warnings = 0;

    for (let i = 0; i < lines.length; i++) {
      const head = lines[i].match(HEAD_RE);
      if (!head) continue;
      const found = diagnostic(lines, i);
      if (!found) continue;
      if (head[1] !== "Error") { warnings++; i = found.end - 1; continue; }
      const { where, stmt, end } = found;
      // The message, the box under it, and the trace at its foot.
      failures.push(withSource({
        file: where?.file, line: where?.line, col: where?.col,
        title: "sass error", label: "sass error", severity: "error",
        message: head[2].trim(), stmt,
      }, i, end));
      i = end - 1;
    }

    if (!failures.length) return null;
    const n = failures.length;
    return {
      tool: "sass",
      summary: n > 1 || warnings
        ? `${counted(n, "error")}${warnings ? ` — ${counted(warnings, "warning")} hidden` : ""}`
        : undefined,
      failures,
    };
  },
};
