// Bundlers report a build failure and then their CLI wrapper reports that the bundler
// exited non-zero. The second one is louder, longer, and says nothing: whatbroke used
// to read an esbuild failure as `Command failed: .../esbuild --bundle` pointing at
// node:internal/errors, with the actual syntax error nowhere on screen.

const ESBUILD_DIAG = /^[✘▲] \[(ERROR|WARNING)\] (?:\[plugin ([^\]]+)\] )?(.+)$/;
// esbuild puts the location on its own line, indented, with a trailing colon:
//     src/app.js:5:24:
const ESBUILD_LOC = /^[ \t]+(\S.*?):(\d+):(\d+):[ \t]*$/;
// and the source under that, in a gutter:  5 │   return sum * (1 + rate;
const ESBUILD_SRC = /^[ \t]*\d+[ \t]*│[ \t]?(.*)$/;

export const esbuild = {
  name: "esbuild",
  category: "compile",
  commands: ["esbuild"],

  detect: (s) => /^[✘▲] \[(?:ERROR|WARNING)\]/m.test(s) && /^\d+ (?:error|warning)s?$/m.test(s),

  extract(s) {
    const lines = s.split("\n");
    const failures = [];
    for (let i = 0; i < lines.length; i++) {
      const d = lines[i].match(ESBUILD_DIAG);
      if (!d || d[1] !== "ERROR") continue;      // warnings are counted, not reported
      let file, line, col, stmt;
      for (let j = i + 1; j < lines.length && j <= i + 4; j++) {
        const loc = lines[j].match(ESBUILD_LOC);
        if (loc) {
          [, file, line, col] = loc;
          stmt = lines[j + 1]?.match(ESBUILD_SRC)?.[1]?.trim();
          break;
        }
        if (ESBUILD_DIAG.test(lines[j])) break;
      }
      failures.push({
        file, line: line ? +line : undefined, col: col ? +col : undefined,
        title: d[2] ?? "build error", label: d[2] ?? "build error",
        severity: "error", message: d[3], stmt,
      });
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
const VITE_DIAG = /^\[([A-Z][A-Z0-9_]+)\][ \t]*(.*)$/;
const VITE_LOC = /^[ \t]*╭─+\[[ \t]*(\S.*?):(\d+):(\d+)[ \t]*\]/;
const VITE_SRC = /^[ \t]*\d+[ \t]*│[ \t]?(.*)$/;

export const vite = {
  name: "vite",
  category: "compile",
  commands: ["vite", "rollup", "rolldown"],

  detect: (s) => /^error during build:/m.test(s) ||
    (/^Build failed with \d+ error/m.test(s) && VITE_DIAG.test(s.split("\n").find((l) => VITE_DIAG.test(l)) ?? "")),

  extract(s) {
    const lines = s.split("\n");
    const failures = [];
    for (let i = 0; i < lines.length; i++) {
      const d = lines[i].match(VITE_DIAG);
      if (!d) continue;
      let file, line, col, stmt;
      for (let j = i + 1; j < lines.length && j <= i + 3; j++) {
        const loc = lines[j].match(VITE_LOC);
        if (loc) {
          [, file, line, col] = loc;
          for (let k = j + 1; k < lines.length && k <= j + 3; k++) {
            const src = lines[k].match(VITE_SRC);
            if (src?.[1]?.trim()) { stmt = src[1].trim(); break; }
          }
          break;
        }
      }
      failures.push({
        file, line: line ? +line : undefined, col: col ? +col : undefined,
        title: d[1], code: d[1], severity: "error", message: d[2] || d[1], stmt,
      });
    }
    if (!failures.length) return null;
    const n = s.match(/^Build failed with (\d+) errors?/m)?.[1] ?? failures.length;
    return { tool: "vite", summary: `build failed with ${n} error${+n > 1 ? "s" : ""}`, failures };
  },
};
