import { isNoise } from "../util.js";

// Babel names the file inside the message and follows the code frame with its own
// parser's stack - twenty frames of @babel/parser, which is the bulk of the log:
//
//   SyntaxError: /abs/bad.jsx: Unexpected token (1:10)
//   > 1 | const x = ;
//       |           ^
//     2 |
//       at constructor (/abs/node_modules/@babel/parser/lib/index.js:325:19)
//       ... twenty more
//
// The position is in the message rather than beside it, and the file is in front of the
// message rather than in a field of its own.
const HEAD_RE = /^(\w*(?:Error|Exception)):[^\S\n]*(\S[^:]*?):[^\S\n]*(.+?)[^\S\n]*\((\d+):(\d+)\)[^\S\n]*$/;
// "> 1 | const x = ;" - the marked line of the code frame.
const MARKED_RE = /^[^\S\n]*>[^\S\n]*(\d+)[^\S\n]*\|[^\S\n]?(.*)$/;

export default {
  name: "babel",
  category: "compile",
  commands: ["babel", "babel-node"],

  // The header alone is a plain SyntaxError, which node writes too. What makes it
  // Babel's is that the file is embedded in the message with the position after it.
  detect: (s) => s.split("\n").some((l) => HEAD_RE.test(l)),

  extract(s) {
    const lines = s.split("\n");
    const failures = [];
    const seen = new Set();
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(HEAD_RE);
      if (!m) continue;
      // A path is a path; anything else in that position is part of the message.
      if (!/[/\\]|\.\w+$/.test(m[2])) continue;
      if (isNoise(m[2])) continue;
      const key = `${m[2]}:${m[4]}:${m[5]}`;
      if (seen.has(key)) continue;
      seen.add(key);

      let stmt;
      for (let j = i + 1; j < lines.length && j <= i + 6; j++) {
        const marked = lines[j].match(MARKED_RE);
        if (marked) { stmt = marked[2].trim(); break; }
      }
      failures.push({
        file: m[2], line: +m[4], col: +m[5],
        title: m[1], code: m[1], severity: "error",
        message: m[3].trim(), stmt,
      });
    }
    if (!failures.length) return null;
    const n = failures.length;
    return { tool: "babel", summary: n > 1 ? `${n} errors` : undefined, failures };
  },
};
