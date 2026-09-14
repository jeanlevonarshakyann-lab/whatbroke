// prettier --check names the files that are not formatted and nothing else:
//
//   Checking formatting...
//   [warn] ugly.js
//   [warn] Code style issues found in the above file. Run Prettier with --write to fix.
//
// It exits non-zero, so a job fails on it; the parser exists so that failure says which
// files rather than nothing at all. The last [warn] is the advice, not a file.
import { withSource } from "../ownership.js";

const FILE_RE = /^\[warn\][^\S\n]+(\S.*?)[^\S\n]*$/;
const ADVICE_RE = /^\[warn\][^\S\n]+Code style issues found/;
const CHECKING_RE = /^Checking formatting\.\.\./m;
const ERROR_RE = /^\[error\][^\S\n]+(\S.*?)[^\S\n]*$/;

export default {
  name: "prettier",
  // Strings a log has to hold for this parser to read anything from it - see src/router.js.
  signals: ["Checking formatting", "Code style issues found"],
  category: "lint",
  commands: ["prettier"],

  detect: (s) => CHECKING_RE.test(s) || ADVICE_RE.test(s),

  extract(s) {
    const failures = [];
    const lines = s.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const bad = lines[i].match(ERROR_RE);
      if (bad) {
        // "[error] file.js: SyntaxError: ..." - a file prettier could not even parse
        const at = bad[1].match(/^(\S+?):[^\S\n]*(.+)$/);
        failures.push(withSource({
          file: at ? at[1] : undefined,
          title: "unparsable", label: "unparsable", severity: "error",
          message: at ? at[2] : bad[1],
        }, i, i + 1));
        continue;
      }
      if (ADVICE_RE.test(lines[i])) continue;
      const m = lines[i].match(FILE_RE);
      if (m) {
        failures.push(withSource({
          file: m[1], title: "not formatted", label: "not formatted", severity: "error",
          message: "this file is not formatted as prettier would write it",
        }, i, i + 1));
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
