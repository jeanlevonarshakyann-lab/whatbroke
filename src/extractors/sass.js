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
const HEAD_RE = /^(Error|Warning|DEPRECATION WARNING)(?:[^\S\n]+on line \d+.*)?:[^\S\n]*(.*)$/;
// "  bad.scss 2:10  root stylesheet" - the trailing phrase names the enclosing rule.
const WHERE_RE = /^[^\S\n]+(\S.*?)[^\S\n]+(\d+):(\d+)[^\S\n]*(?:[^\S\n]{2,}(.*))?$/;
// The box: a gutter rune, an echoed source line, a caret run.
const BOX_RE = /^[^\S\n]*(?:\d+[^\S\n]*)?[╷│╵]/;
// esbuild and vite draw a gutter with the same "│", so that rune alone identifies
// nothing - and esbuild closes its box with "╵" as well. What it never writes is the
// opening cap, which sass puts above every diagnostic it draws.
const BOX_CAP_RE = /^[^\S\n]*╷[^\S\n]*$/;
const SOURCE_RE = /^[^\S\n]*(\d+)[^\S\n]*│[^\S\n]?(.*)$/;

export default {
  name: "sass",
  category: "compile",
  commands: ["sass", "scss", "node-sass"],

  // The box runes are sass's own and nothing else in the corpus draws them; requiring
  // one alongside the header keeps "Error: ..." from claiming another tool's line.
  detect: (s) => {
    const lines = s.split("\n");
    return lines.some((l) => HEAD_RE.test(l)) && lines.some((l) => BOX_CAP_RE.test(l));
  },

  extract(s) {
    const lines = s.split("\n");
    const failures = [];
    let warnings = 0;

    for (let i = 0; i < lines.length; i++) {
      const head = lines[i].match(HEAD_RE);
      if (!head) continue;
      // "Error: ..." belongs to half the tools in existence. What makes it sass's is the
      // box it opens directly underneath - without that check, every other tool's error
      // line in a shared log became a sass diagnostic.
      let opens = false;
      for (let j = i + 1; j < lines.length && j <= i + 2; j++) {
        if (BOX_CAP_RE.test(lines[j])) { opens = true; break; }
      }
      if (!opens) continue;
      if (head[1] !== "Error") { warnings++; continue; }

      let where = null, stmt;
      for (let j = i + 1; j < lines.length && j <= i + 12; j++) {
        if (HEAD_RE.test(lines[j])) break;
        const src = lines[j].match(SOURCE_RE);
        if (src) { stmt ??= src[2].trim(); continue; }
        if (BOX_RE.test(lines[j])) continue;
        const w = lines[j].match(WHERE_RE);
        if (w) { where = { file: w[1], line: +w[2], col: +w[3], scope: w[4]?.trim() }; break; }
      }

      failures.push({
        file: where?.file, line: where?.line, col: where?.col,
        title: "sass error", label: "sass error", severity: "error",
        message: head[2].trim(), stmt,
      });
      if (where) i += 1;
    }

    if (!failures.length) return null;
    const n = failures.length;
    return {
      tool: "sass",
      summary: n > 1 || warnings
        ? `${n} error${n === 1 ? "" : "s"}${warnings ? `, ${warnings} warning${warnings === 1 ? "" : "s"}` : ""}`
        : undefined,
      failures,
    };
  },
};
