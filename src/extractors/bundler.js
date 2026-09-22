// Bundlers report a build failure and then their CLI wrapper reports that the bundler
// exited non-zero. The second one is louder, longer, and says nothing: whyitbroke used
// to read an esbuild failure as `Command failed: .../esbuild --bundle` pointing at
// node:internal/errors, with the actual syntax error nowhere on screen.

import { withSource } from "../ownership.js";

const ESBUILD_DIAG = /^[✘▲] \[(ERROR|WARNING)\] (?:\[plugin ([^\]]+)\] )?(.+)$/;
// esbuild puts the location on its own line, indented, with a trailing colon:
//     src/app.js:5:24:
// and counts the column from 0. That one is the semicolon in `  return sum * (1 + rate;`,
// the 25th character, where esbuild draws its caret; vite's rolldown says 5:25 of the same
// line. A column here counts from 1.
const ESBUILD_LOC = /^[^\S\n]+(\S.*?):(\d+):(\d+):[^\S\n]*$/;
// and the source under that, in a gutter:  5 │   return sum * (1 + rate;
const ESBUILD_SRC = /^[^\S\n]*\d+[^\S\n]*│[^\S\n]?(.*)$/;

export const esbuild = {
  name: "esbuild",
  // Strings a log has to hold for this parser to read anything from it - see src/router.js.
  signals: ["[ERROR]", "[WARNING]"],
  category: "compile",
  commands: ["esbuild"],

  detect: (s) => /^[✘▲] \[(?:ERROR|WARNING)\]/m.test(s) && /^\d+ (?:error|warning)s?$/m.test(s),

  extract(s) {
    const lines = s.split("\n");
    const failures = [];
    for (let i = 0; i < lines.length; i++) {
      const d = lines[i].match(ESBUILD_DIAG);
      if (!d || d[1] !== "ERROR") continue;      // warnings are counted, not reported
      // The diagnostic, its location, and the source line under that.
      let file, line, col, stmt, end = i + 1;
      for (let j = i + 1; j < lines.length && j <= i + 4; j++) {
        const loc = lines[j].match(ESBUILD_LOC);
        if (loc) {
          [, file, line, col] = loc;
          stmt = lines[j + 1]?.match(ESBUILD_SRC)?.[1]?.trim();
          end = stmt === undefined ? j + 1 : j + 2;
          break;
        }
        if (ESBUILD_DIAG.test(lines[j])) break;
      }
      failures.push(withSource({
        file, line: line ? +line : undefined, col: col ? +col + 1 : undefined,
        title: d[2] ?? "build error", label: d[2] ?? "build error",
        severity: "error", message: d[3], stmt,
      }, i, end));
    }
    if (!failures.length) return null;
    const counted = s.match(/^(\d+) errors?$/m);
    const warned = s.match(/^(\d+) warnings?$/m);
    return {
      tool: "esbuild",
      summary: `${counted?.[1] ?? failures.length} error${(+(counted?.[1] ?? failures.length)) > 1 ? "s" : ""}` +
        (warned ? ` — ${warned[1]} warning${+warned[1] > 1 ? "s" : ""} hidden` : ""),
      failures,
    };
  },
};

// Vite (and rollup/rolldown under it) leads with a bracketed code and draws the
// location in a box:   ╭─[ src/clean.js:1:22 ]
const VITE_DIAG = /^\[([A-Z][A-Z0-9_]+)\][^\S\n]*(.*)$/;
// `[INFO]`, `[WARN]`, `[DEBUG]` are what every other tool in the log is printing, and
// they match a rollup code exactly. Build logs are full of them.
const LOG_LEVEL = /^(?:INFO|WARN|WARNING|DEBUG|TRACE|NOTICE|ERROR|FATAL|LOG)$/;
const VITE_LOC = /^[^\S\n]*╭─+\[[^\S\n]*(\S.*?):(\d+):(\d+)[^\S\n]*\]/;
const VITE_SRC = /^[^\S\n]*\d+[^\S\n]*│[^\S\n]?(.*)$/;

export const vite = {
  name: "vite",
  // Strings a log has to hold for this parser to read anything from it - see src/router.js.
  signals: ["error during build:", "Build failed with"],
  category: "compile",
  commands: ["vite", "rollup", "rolldown"],

  detect: (s) => /^error during build:/m.test(s) ||
    (/^Build failed with \d+ error/m.test(s) && VITE_DIAG.test(s.split("\n").find((l) => VITE_DIAG.test(l)) ?? "")),

  extract(s) {
    const lines = s.split("\n");
    const failures = [];
    // Only the lines after vite says it failed are diagnostics. Everything above is the
    // build's own chatter, and some of it is bracketed exactly like a rollup code.
    const start = lines.findIndex((l) => /^error during build:/.test(l) || /^Build failed with \d+ error/.test(l));
    for (let i = start < 0 ? 0 : start; i < lines.length; i++) {
      const d = lines[i].match(VITE_DIAG);
      if (!d || LOG_LEVEL.test(d[1])) continue;
      // The code and message, the box's location, and the source line drawn in it.
      let file, line, col, stmt, end = i + 1;
      for (let j = i + 1; j < lines.length && j <= i + 3; j++) {
        const loc = lines[j].match(VITE_LOC);
        if (loc) {
          [, file, line, col] = loc;
          end = j + 1;
          for (let k = j + 1; k < lines.length && k <= j + 3; k++) {
            const src = lines[k].match(VITE_SRC);
            if (src?.[1]?.trim()) { stmt = src[1].trim(); end = k + 1; break; }
          }
          break;
        }
      }
      failures.push(withSource({
        file, line: line ? +line : undefined, col: col ? +col : undefined,
        title: d[1], code: d[1], severity: "error", message: d[2] || d[1], stmt,
      }, i, end));
    }
    if (!failures.length) return null;
    const n = s.match(/^Build failed with (\d+) errors?/m)?.[1] ?? failures.length;
    return { tool: "vite", summary: `build failed with ${n} error${+n > 1 ? "s" : ""}`, failures };
  },
};
