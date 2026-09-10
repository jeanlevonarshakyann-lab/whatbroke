// lessc puts everything on the header line - the class, the message, the file, the line
// and the column - and echoes the source under it:
//
//   NameError: variable @undefined-var is undefined in /abs/bad.less on line 1, column 13:
//   1 .a { color: @undefined-var; }
//
// Self-bounding: there is nothing to scan for, because the whole diagnostic is one line.
const HEAD_RE = /^(\w*(?:Error|Exception)):[^\S\n]*(.+?)[^\S\n]+in[^\S\n]+(\S+)[^\S\n]+on line[^\S\n]+(\d+)(?:,[^\S\n]+column[^\S\n]+(\d+))?:?[^\S\n]*$/;
// "1 .a { color: @undefined-var; }" - the number, a space, the source.
const SOURCE_RE = /^[^\S\n]*(\d+)[^\S\n](.*)$/;

export default {
  name: "less",
  category: "compile",
  commands: ["lessc", "less"],

  detect: (s) => s.split("\n").some((l) => HEAD_RE.test(l)),

  extract(s) {
    const lines = s.split("\n");
    const failures = [];
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(HEAD_RE);
      if (!m) continue;
      let stmt;
      for (let j = i + 1; j < lines.length && j <= i + 3; j++) {
        const src = lines[j].match(SOURCE_RE);
        if (src && +src[1] === +m[4]) { stmt = src[2].trim(); break; }
      }
      failures.push({
        file: m[3], line: +m[4], col: m[5] ? +m[5] : undefined,
        title: m[1], code: m[1], severity: "error",
        message: m[2].trim(), stmt,
      });
    }
    if (!failures.length) return null;
    const n = failures.length;
    return { tool: "less", summary: n > 1 ? `${n} errors` : undefined, failures };
  },
};
