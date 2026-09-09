import { isNoise } from "../util.js";

const ERR_RE = /^(?:Uncaught )?((?:[A-Z]\w*)?(?:Error|Exception)(?:\s\[[\w_]+\])?): ?(.*)$/;

export default {
  name: "node",
  category: "runtime",
  commands: ["node"],
  detect: (s) => /^[ \t]+at .+\(.+:\d+:\d+\)$/m.test(s) || /^[ \t]+at .+:\d+:\d+$/m.test(s),

  extract(s) {
    const lines = s.split("\n");
    let errIdx = -1, errType = "", errMsg = "";
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(ERR_RE);
      if (m) { errIdx = i; errType = m[1]; errMsg = m[2]; break; }
    }
    if (errIdx < 0) return null;

    // frames after the error line
    const frames = [];
    for (let i = errIdx + 1; i < lines.length; i++) {
      const m = lines[i].match(/^[ \t]+at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/);
      if (!m) { if (frames.length) break; else continue; }
      frames.push({ fn: m[1] ?? "<anonymous>", file: m[2], line: +m[3], col: +m[4] });
    }
    const user = frames.filter((f) => !isNoise(f.file));
    const top = user[0] ?? frames[0];

    // node prints "file:line \n <source> \n <caret>" above the error for uncaught throws
    let stmt;
    for (let i = 0; i < errIdx; i++) {
      if (/^[ \t]*\^+[ \t]*$/.test(lines[i]) && i >= 1) { stmt = lines[i - 1].trim(); break; }
    }

    return {
      tool: "node",
      failures: [{
        file: top?.file, line: top?.line, col: top?.col,
        title: errType, code: errType, severity: "error", message: errMsg, stmt,
        trace: user.slice(0, 4).map((f) => `${f.fn} (${f.file}:${f.line}:${f.col})`),
        hiddenFrames: frames.length - user.length,
      }],
    };
  },
};
