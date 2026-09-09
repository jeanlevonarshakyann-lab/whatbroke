// pnpm and yarn report failures in formats npm's parser does not recognise at all, so
// until now the most-run commands in a JavaScript project produced no diagnosis.
//
// Both also end with advice rather than a diagnosis - yarn's "info Visit
// https://yarnpkg.com/..." and pnpm's "WARN Local package.json exists" - which is the
// same trailing noise npm's parser already drops.

// pnpm prints a code, two or more spaces, then the message:
//    ERR_PNPM_NO_SCRIPT  Missing script: build
//    ELIFECYCLE  Command failed with exit code 3.
const PNPM_LINE = /^[^\S\n]+([A-Z][A-Z0-9_]+)[^\S\n]{2,}(.+?)[^\S\n]*$/;
const PNPM_WARN = /^(?:WARN|WARNING|INFO|DEBUG|NOTICE)$/;

export const pnpm = {
  name: "pnpm",
  category: "package",
  commands: ["pnpm", "pnpx"],

  // ERR_PNPM_* is pnpm's alone. ELIFECYCLE is shared with npm, but npm writes it as
  // `npm error code ELIFECYCLE`, never as an indented column.
  detect: (s) => /^[^\S\n]+ERR_PNPM_[A-Z0-9_]+[^\S\n]{2,}/m.test(s) ||
    (/^[^\S\n]+ELIFECYCLE[^\S\n]{2,}/m.test(s) && !/^npm (?:error|ERR!)[^\S\n]/m.test(s)),

  extract(s) {
    const failures = [];
    for (const l of s.split("\n")) {
      const m = l.match(PNPM_LINE);
      if (!m || PNPM_WARN.test(m[1])) continue;
      failures.push({ title: m[1], code: m[1], severity: "error", message: m[2] });
    }
    if (!failures.length) return null;
    // ELIFECYCLE only says the script exited non-zero; a more specific code above it
    // says why, and that is the one worth leading with.
    const specific = failures.filter((f) => f.code !== "ELIFECYCLE");
    const kept = specific.length ? specific : failures;
    return { tool: "pnpm", summary: kept[0].message, failures: kept };
  },
};

// yarn v1 prints a bare level word and then the message:
//    error Command failed with exit code 3.
//    warning package.json: No license field
//    info Visit https://yarnpkg.com/en/docs/cli/run for documentation
const YARN_LINE = /^(error|warning|info)[^\S\n]+(.+?)[^\S\n]*$/;
// Everything from here down is documentation, not diagnosis.
const YARN_ADVICE = /^info Visit https:\/\/yarnpkg\.com/;

export const yarn = {
  name: "yarn",
  category: "package",
  commands: ["yarn"],

  // `error ` on its own belongs to half the tools in existence, so it has to be
  // corroborated by something only yarn prints.
  detect: (s) => /^yarn run v\d/m.test(s) || /^info Visit https:\/\/yarnpkg\.com/m.test(s) ||
    /^error Command failed with exit code \d+\.$/m.test(s),

  extract(s) {
    const failures = [];
    for (const l of s.split("\n")) {
      if (YARN_ADVICE.test(l)) break;
      const m = l.match(YARN_LINE);
      if (!m || m[1] !== "error") continue;
      failures.push({ title: "error", label: "error", severity: "error", message: m[2] });
    }
    if (!failures.length) return null;
    return { tool: "yarn", summary: failures[0].message, failures };
  },
};
