// flake8 writes one finding per line and nothing else:
//
//   lint_me.py:1:1: F401 'os' imported but unused
//   lint_me.py:2:16: E231 missing whitespace after ','
//
import { joinSources, withSource } from "../ownership.js";
import { locatedPrefix } from "../location.js";

// Self-bounding: the whole finding is one line. The code is what you would put in a
// noqa comment or a per-file ignore, so it is the code; its letter says what kind of
// check it came from, and E9/F8 are the ones that stop a build rather than tidy it.
const DETAIL_RE = /^[^\S\n]+([A-Z]{1,4}\d{3,4})[^\S\n]+(.+?)[^\S\n]*$/;
const finding = (line) => line.startsWith("::") ? null : locatedPrefix(line, (rest) => {
  const match = rest.match(DETAIL_RE);
  return match ? { code: match[1], message: match[2] } : null;
});
// --format=pylint moves the code into brackets and drops the column:
//
//   lint_me.py:1: [F401] 'os' imported but unused
//
// It went to the generic reader, which kept the file and line and put the code in the
// message. pylint's own parseable format looks alike but always writes the check's name
// in the bracket too - `[W0611(unused-import), ]` - so a bare code is flake8's.
const PYLINT_DETAIL_RE = /^[^\S\n]+\[([A-Z]{1,4}\d{3,4})\][^\S\n]+(.+?)[^\S\n]*$/;
const pylintFinding = (line) => line.startsWith("::") ? null : locatedPrefix(line, (rest) => {
  const match = rest.match(PYLINT_DETAIL_RE);
  return match ? { code: match[1], message: match[2] } : null;
}, { column: false });

export default {
  name: "flake8",
  category: "lint",
  commands: ["flake8", "pycodestyle", "pyflakes"],

  // pylint writes the same shape with a colon after its code, so requiring NO colon
  // there is what keeps the two apart.
  detect: (s) => s.split("\n").some((line) => finding(line) || pylintFinding(line)),

  extract(s) {
    const failures = [];
    const seen = new Map();
    const lines = s.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const m = finding(line);
      const p = m ? null : pylintFinding(line);
      if (!m && !p) continue;
      const { file, line: row, col, code, message } = m ?? p;
      const key = `${file}:${row}:${col ?? ""}:${code}`;
      const failure = withSource({
        file, line: +row, ...(col ? { col: +col } : {}),
        title: code, code, severity: "error",
        message: message.trim(),
      }, i, i + 1);
      if (seen.has(key)) { failures[seen.get(key)] = joinSources(failures[seen.get(key)], failure); continue; }
      seen.set(key, failures.length);
      failures.push(failure);
    }
    if (!failures.length) return null;
    const n = failures.length;
    const files = new Set(failures.map((f) => f.file)).size;
    return {
      tool: "flake8",
      summary: `${n} problem${n === 1 ? "" : "s"}${files > 1 ? ` in ${files} files` : ""}`,
      failures,
    };
  },
};
