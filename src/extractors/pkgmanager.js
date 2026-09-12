// pnpm and yarn report failures in formats npm's parser does not recognise at all, so
// until now the most-run commands in a JavaScript project produced no diagnosis.
//
// Both also end with advice rather than a diagnosis - yarn's "info Visit
// https://yarnpkg.com/..." and pnpm's "WARN Local package.json exists" - which is the
// same trailing noise npm's parser already drops.

// pnpm prints a code, two or more spaces, then the message:
//    ERR_PNPM_NO_SCRIPT  Missing script: build
//    ELIFECYCLE  Command failed with exit code 3.
// The code has to look like one. Matching any indented UPPERCASE word followed by two
// spaces made this claim vitest's " FAIL  src/x.spec.ts > name" lines as pnpm failures -
// 56 of them across the fixture corpus. pnpm's codes are ERR_PNPM_* or a node-style
// E-code: ELIFECYCLE, ENOENT, EACCES.
const PNPM_LINE = /^[^\S\n]+(ERR_PNPM_[A-Z0-9_]+|E[A-Z]{3,})[^\S\n]{2,}(.+?)[^\S\n]*$/;
const PNPM_WARN = /^(?:WARN|WARNING|INFO|DEBUG|NOTICE)$/;

// Newer pnpm draws the same failure as a box instead of a column, and nothing read it -
// the code was all the generic fallback could find, so a failed install said
// ERR_PNPM_FETCH_404 and never which package, or why:
//
//   Error: ERR_PNPM_FETCH_404
//
//     × installing dependencies
//     ╰─▶ Failed to resolve dependency tree: GET https://registry.npmjs.org/left-
//         pad: Not Found - 404
//     help: left-pad is not in the npm registry, or
//           you have no permission to fetch it.
//
// The arrow is the diagnosis, the cross is what pnpm was doing at the time, and `help:`
// is what to do next. All three are hard-wrapped, and the wrap lands mid-token often
// enough to matter: joining the continuation with a space turns a package name into two.
const PNPM_HEAD = /^Error:[^\S\n]+(ERR_PNPM_[A-Z0-9_]+|E[A-Z]{3,})[^\S\n]*$/;
const PNPM_BOX = /^[^\S\n]*(?:×|╰─▶|help:)[^\S\n]*(.*)$/;
const PNPM_CAUSE = /^[^\S\n]*╰─▶[^\S\n]*(.*)$/;

/** One wrapped pnpm line and the continuations under it, put back together.
 *
 *  pnpm breaks the line wherever it runs out of width, and a break after a hyphen or a
 *  slash is inside a word: `registry.npmjs.org/left-` and `pad` are one package, not
 *  two. Anywhere else the break is between words and the space belongs. */
function unwrap(lines, at, indent) {
  let text = lines[at].replace(PNPM_BOX, "$1").trimEnd();
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || PNPM_BOX.test(line) || PNPM_HEAD.test(line)) break;
    const width = line.length - line.trimStart().length;
    if (width <= indent) break;
    text += (/[-/]$/.test(text) ? "" : " ") + line.trim();
  }
  return text;
}

/** The failure a boxed pnpm error describes, or null. */
function boxed(s) {
  const lines = s.split("\n");
  const at = lines.findIndex((l) => PNPM_HEAD.test(l));
  if (at < 0) return null;
  const code = lines[at].match(PNPM_HEAD)[1];
  const said = [];
  for (let i = at + 1; i < lines.length; i++) {
    if (PNPM_HEAD.test(lines[i])) break;
    if (!PNPM_BOX.test(lines[i])) continue;
    const indent = lines[i].length - lines[i].trimStart().length;
    said.push({ cause: PNPM_CAUSE.test(lines[i]), text: unwrap(lines, i, indent) });
  }
  if (!said.length) return null;
  // The arrow says what went wrong; the cross only says what pnpm was in the middle of.
  const cause = said.find((p) => p.cause) ?? said[0];
  const rest = said.filter((p) => p !== cause && !p.cause).map((p) => p.text);
  return {
    title: code, code, severity: "error",
    message: [cause.text, ...rest].filter(Boolean).slice(0, 3).join("\n"),
  };
}

export const pnpm = {
  name: "pnpm",
  category: "package",
  commands: ["pnpm", "pnpx"],
  commandHints: [],

  // ERR_PNPM_* is pnpm's alone. ELIFECYCLE is shared with npm, but npm writes it as
  // `npm error code ELIFECYCLE`, never as an indented column.
  detect: (s) => /^[^\S\n]+ERR_PNPM_[A-Z0-9_]+[^\S\n]{2,}/m.test(s) ||
    /^[^\S\n]+ELIFECYCLE[^\S\n]{2,}/m.test(s) ||
    s.split("\n").some((l) => PNPM_HEAD.test(l)),

  extract(s) {
    const failures = [];
    for (const l of s.split("\n")) {
      const m = l.match(PNPM_LINE);
      if (!m || PNPM_WARN.test(m[1])) continue;
      failures.push({ title: m[1], code: m[1], severity: "error", message: m[2] });
    }
    const box = boxed(s);
    if (box && !failures.some((f) => f.code === box.code)) failures.push(box);
    if (!failures.length) return null;
    // ELIFECYCLE only says the script exited non-zero; a more specific code above it
    // says why, and that is the one worth leading with.
    const specific = failures.filter((f) => f.code !== "ELIFECYCLE");
    const kept = specific.length ? specific : failures;
    // The headline is one line. The boxed form's message is three - what went wrong,
    // what pnpm was doing, and what to do about it - and all three in the headline is
    // not a headline.
    return { tool: "pnpm", summary: kept[0].message.split("\n")[0], failures: kept };
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
  commandHints: [],

  // `error ` on its own belongs to half the tools in existence, so it has to be
  // corroborated by something only yarn prints.
  detect: (s) => /^yarn run v\d/m.test(s) || /^info Visit https:\/\/yarnpkg\.com/m.test(s) ||
    /^error Command failed with exit code \d+\.$/m.test(s),

  extract(s) {
    const failures = [];
    const lines = s.split("\n");
    // yarn's output is a block: the banner opens it, the advice line closes it. Scanning
    // from the top of the log instead meant anything above the banner was read as yarn's,
    // and vite opens a failed build with "error during build:" - which is exactly the
    // shape. When there is no banner the whole log is the block, as before.
    const banner = lines.findIndex((l) => /^yarn run v\d/.test(l));
    for (const l of lines.slice(banner < 0 ? 0 : banner)) {
      if (YARN_ADVICE.test(l)) break;
      const m = l.match(YARN_LINE);
      if (!m || m[1] !== "error") continue;
      // TypeScript's location-free diagnostics also start with "error ". Its code
      // identifies the owner even when a yarn banner is elsewhere in the same log.
      if (/^TS\d+: /.test(m[2])) continue;
      failures.push({ title: "error", label: "error", severity: "error", message: m[2] });
    }
    if (!failures.length) return null;
    return { tool: "yarn", summary: failures[0].message, failures };
  },
};
