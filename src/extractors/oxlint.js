// oxlint writes one line per finding, with the rule in parentheses after the severity
// and the fix suggestion appended to the message:
//
//   lintme.js:1:5: error eslint(no-unused-vars): Variable 'unused' is declared but
//   never used. ... help: Consider removing this declaration.
//
// Self-bounding: the whole finding is one line. The rule name is what you would disable,
// so it is the code; the plugin qualifier in front of it is not part of that name.
const FINDING_RE = /^(\S+?):(\d+):(\d+):[^\S\n]+(error|warning)[^\S\n]+(?:([\w-]+)\()?([\w-]+)\)?:[^\S\n]*(.+?)[^\S\n]*$/;
// "... help: Consider removing this declaration." - advice, not what happened.
const HELP_RE = /[^\S\n]*\bhelp:[^\S\n].*$/;
const TALLY_RE = /^Found (\d+) warnings? and (\d+) errors?/m;

export default {
  name: "oxlint",
  category: "lint",
  commands: ["oxlint"],

  detect: (s) => TALLY_RE.test(s) || s.split("\n").some((l) => FINDING_RE.test(l)),

  extract(s) {
    const failures = [];
    let warnings = 0;
    for (const line of s.split("\n")) {
      const m = line.match(FINDING_RE);
      if (!m) continue;
      if (m[4] !== "error") { warnings++; continue; }
      failures.push({
        file: m[1], line: +m[2], col: +m[3],
        title: m[6], code: m[6], severity: "error",
        message: m[7].replace(HELP_RE, "").trim(),
      });
    }
    if (!failures.length) return null;
    const n = failures.length;
    return {
      tool: "oxlint",
      summary: `${n} error${n === 1 ? "" : "s"}` +
        (warnings ? `, ${warnings} warning${warnings === 1 ? "" : "s"} hidden` : ""),
      failures,
    };
  },
};
