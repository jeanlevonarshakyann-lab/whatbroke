// webpack heads each problem with the module it happened in, then explains, then prints
// the resolver's entire search:
//
//   ERROR in ./wsrc/index.js 1:0-36
//   Module not found: Error: Can't resolve './missing.js' in '/abs/wsrc'
//   resolve './missing.js' in '/abs/wsrc'
//     using description file: ... (relative path: ./wsrc)
//       Field 'browser' doesn't contain a valid alias configuration
//   ... forty more lines of the same
//
// The trace is how webpack looked, not what went wrong, and it is the bulk of the log.
const HEAD_RE = /^(ERROR|WARNING) in (\S+?)(?:[^\S\n]+(\d+):(\d+)(?:-\d+)?)?[^\S\n]*$/;
const TALLY_RE = /^webpack [\d.]+ compiled with (\d+) errors?(?:[^\S\n]+and[^\S\n]+(\d+) warnings?)?/m;
// Where the explanation stops and the resolver's diary begins.
const TRACE_RE = /^(?:resolve[ds]?[^\S\n]|[^\S\n]+(?:using description file|Field '|aliased from|Failed to alias|doesn't exist|as directory|no extension))/;
// webpack echoes the offending line with a > marker, like a compiler.
const SOURCE_RE = /^[^\S\n]*>[^\S\n]*(\d+)[^\S\n]*\|[^\S\n]?(.*)$/;
// The rest of the drawing: unmarked source lines and the caret under them.
const GUTTER_RE = /^[^\S\n]*\d*[^\S\n]*\|/;
const ADVICE_RE = /^(?:You may need an appropriate loader|File was parsed as|See https?:\/\/)/;
const MAX_MESSAGE_LINES = 2;

export default {
  name: "webpack",
  category: "compile",
  commands: ["webpack", "webpack-cli"],

  detect: (s) => TALLY_RE.test(s) || /^ERROR in \S/m.test(s),

  extract(s) {
    const lines = s.split("\n");
    const failures = [];
    let warnings = 0;

    for (let i = 0; i < lines.length; i++) {
      const head = lines[i].match(HEAD_RE);
      if (!head) continue;
      if (head[1] !== "ERROR") { warnings++; continue; }

      const msg = [];
      let stmt;
      for (let j = i + 1; j < lines.length && j <= i + 20; j++) {
        if (HEAD_RE.test(lines[j]) || TALLY_RE.test(lines[j])) break;
        if (TRACE_RE.test(lines[j]) || ADVICE_RE.test(lines[j])) continue;
        const src = lines[j].match(SOURCE_RE);
        if (src) { stmt ??= src[2].trim(); continue; }
        if (GUTTER_RE.test(lines[j])) continue;
        if (lines[j].trim() && msg.length < MAX_MESSAGE_LINES) {
          // "Module not found: Error: Can't resolve ..." says the same thing twice
          msg.push(lines[j].trim().replace(/^Module not found:[^\S\n]*Error:[^\S\n]*/, "Module not found: "));
        }
      }

      failures.push({
        file: head[2], line: head[3] ? +head[3] : undefined, col: head[4] ? +head[4] : undefined,
        title: "build error", label: "build error", severity: "error",
        message: msg.join("\n") || "webpack reported an error with no explanation", stmt,
      });
    }

    if (!failures.length) return null;
    const t = s.match(TALLY_RE);
    const n = failures.length;
    return {
      tool: "webpack",
      summary: `${t ? t[1] : n} error${(t ? +t[1] : n) === 1 ? "" : "s"}` +
        (warnings ? `, ${warnings} warning${warnings === 1 ? "" : "s"}` : ""),
      failures,
    };
  },
};
