import { isNoise } from "../util.js";

const ERR_RE = /^(?:Uncaught )?((?:[A-Z]\w*)?(?:Error|Exception)(?:\s\[[\w_]+\])?): ?(.*)$/;
// ESM reports every path as a file:// URL, which is not something that can be opened -
// so source context was never shown for a module, and the location read as a URL.
const unfile = (p) => (p?.startsWith("file://") ? decodeURIComponent(p.slice(7)) : p);

export default {
  name: "node",
  category: "runtime",
  commands: ["node"],
  detect: (s) => /^[^\S\n]+at .+\(.+:\d+:\d+\)$/m.test(s) || /^[^\S\n]+at .+:\d+:\d+$/m.test(s),

  extract(s) {
    const lines = s.split("\n");
    let errIdx = -1, errType = "", errMsg = "";
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(ERR_RE);
      if (m) { errIdx = i; errType = m[1]; errMsg = m[2]; break; }
    }
    if (errIdx < 0) return null;

    // Frames follow the error, and follow it closely: a real stack starts on the next
    // line or the one after a blank. Scanning forward without limit meant that in a log
    // holding more than one tool, an "Error:" line belonging to somebody else - Go
    // printing an expected error string in a test - reached down the log and adopted
    // another tool's frames.
    // Nor can a diagnostic own a stack that another diagnostic stands in front of. A
    // Python traceback ending "KeyError: 'taxrate'" is read as a Node error - the shape
    // is identical - and with a deno failure pasted under it, deno's own message sat
    // between the two and the frame beneath that was exactly FRAME_GAP away.
    const OTHER_DIAGNOSTIC = /^(?:error|Error|warning):[^\S\n]/;
    const FRAME_GAP = 3;
    const frames = [];
    for (let i = errIdx + 1; i < lines.length; i++) {
      if (OTHER_DIAGNOSTIC.test(lines[i])) break;
      const m = lines[i].match(/^[^\S\n]+at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/);
      if (!m) { if (frames.length || i - errIdx > FRAME_GAP) break; else continue; }
      frames.push({ fn: m[1] ?? "<anonymous>", file: unfile(m[2]), line: +m[3], col: +m[4] });
    }
    const user = frames.filter((f) => !isNoise(f.file));

    // node prints "file:line \n <source> \n <caret>" above the error for uncaught throws
    let stmt, header;
    for (let i = 0; i < errIdx; i++) {
      if (/^[^\S\n]*\^+[^\S\n]*$/.test(lines[i]) && i >= 1) {
        stmt = lines[i - 1].trim();
        // and the line above the source names the file, which for a syntax error or a
        // failed import is the ONLY place the real location appears - the stack is
        // entirely node's own machinery.
        const h = lines[i - 2]?.match(/^(\S.*?):(\d+)$/);
        if (h) header = { file: unfile(h[1]), line: +h[2] };
        break;
      }
    }

    // Prefer a frame in your code; then the header, which is where node puts the truth
    // for a syntax error; and failing both, no location at all. Reporting
    // node:internal/modules/esm/resolve:275 is true and useless, and it reads as though
    // the bug were in node.
    // An "Error:" line with no stack under it and no header above it is not a Node
    // failure - it is a line that happens to start with the word, and in a log holding
    // more than one tool it usually belongs to another one. Go prints expected error
    // strings in test output that read exactly like this.
    if (!frames.length && !header) return null;

    const usable = (loc) => (loc && !isNoise(loc.file) ? loc : null);
    const top = user[0] ?? usable(header) ?? usable(frames[0]);

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
