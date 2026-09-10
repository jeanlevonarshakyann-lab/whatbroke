// prettier --check names the files that are not formatted and nothing else:
//
//   Checking formatting...
//   [warn] ugly.js
//   [warn] Code style issues found in the above file. Run Prettier with --write to fix.
//
// It exits non-zero, so a job fails on it; the parser exists so that failure says which
// files rather than nothing at all. The last [warn] is the advice, not a file.
const FILE_RE = /^\[warn\][^\S\n]+(\S.*?)[^\S\n]*$/;
const ADVICE_RE = /^\[warn\][^\S\n]+Code style issues found/;
const CHECKING_RE = /^Checking formatting\.\.\./m;
const ERROR_RE = /^\[error\][^\S\n]+(\S.*?)[^\S\n]*$/;

export default {
  name: "prettier",
  category: "lint",
  commands: ["prettier"],

  detect: (s) => CHECKING_RE.test(s) || ADVICE_RE.test(s),

  extract(s) {
    const failures = [];
    for (const line of s.split("\n")) {
      const bad = line.match(ERROR_RE);
      if (bad) {
        // "[error] file.js: SyntaxError: ..." - a file prettier could not even parse
        const at = bad[1].match(/^(\S+?):[^\S\n]*(.+)$/);
        failures.push({
          file: at ? at[1] : undefined,
          title: "unparsable", label: "unparsable", severity: "error",
          message: at ? at[2] : bad[1],
        });
        continue;
      }
      if (ADVICE_RE.test(line)) continue;
      const m = line.match(FILE_RE);
      if (m) {
        failures.push({
          file: m[1], title: "not formatted", label: "not formatted", severity: "error",
          message: "this file is not formatted as prettier would write it",
        });
      }
    }
    if (!failures.length) return null;
    const n = failures.length;
    // "needs formatting" says nothing went wrong, and the run exited non-zero. The
    // guarantees suite catches a headline that reads like success, and caught this one.
    return {
      tool: "prettier",
      summary: `${n} file${n === 1 ? "" : "s"} failed the format check`,
      failures,
    };
  },
};
