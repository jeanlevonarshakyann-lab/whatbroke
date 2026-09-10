// flake8 writes one finding per line and nothing else:
//
//   lint_me.py:1:1: F401 'os' imported but unused
//   lint_me.py:2:16: E231 missing whitespace after ','
//
// Self-bounding: the whole finding is one line. The code is what you would put in a
// noqa comment or a per-file ignore, so it is the code; its letter says what kind of
// check it came from, and E9/F8 are the ones that stop a build rather than tidy it.
const FINDING_RE = /^(\S+?):(\d+):(\d+):[^\S\n]+([A-Z]{1,4}\d{3,4})[^\S\n]+(.+?)[^\S\n]*$/;

export default {
  name: "flake8",
  category: "lint",
  commands: ["flake8", "pycodestyle", "pyflakes"],

  // pylint writes the same shape with a colon after its code, so requiring NO colon
  // there is what keeps the two apart.
  detect: (s) => s.split("\n").some((l) => FINDING_RE.test(l)),

  extract(s) {
    const failures = [];
    const seen = new Set();
    for (const line of s.split("\n")) {
      const m = line.match(FINDING_RE);
      if (!m) continue;
      const key = `${m[1]}:${m[2]}:${m[3]}:${m[4]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      failures.push({
        file: m[1], line: +m[2], col: +m[3],
        title: m[4], code: m[4], severity: "error",
        message: m[5].trim(),
      });
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
