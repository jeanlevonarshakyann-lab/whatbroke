// yamllint's default output puts the filename on its own line and indents the findings
// under it, so no line carries both a location and a message and the whole run came back
// "could not identify a diagnostic". Under `-f parsable` each finding is one line and the
// generic fallback scraped those, counting yamllint's warnings among the errors.
//
//   app.yml
//     2:1       error    duplication of key "key" in mapping  (key-duplicates)
//     5:81      error    line too long (106 > 80 characters)  (line-length)
//
// The rule is the last parenthesised word on the line, and it has to be matched as one:
// yamllint writes messages that contain brackets of their own, and "line too long (106 >
// 80 characters)" would otherwise be read as the rule name.
const RULE = "\\(([\\w-]+)\\)[^\\S\\n]*$";
const TTY = new RegExp(`^[^\\S\\n]+(\\d+):(\\d+)[^\\S\\n]+(error|warning)[^\\S\\n]+(.+?)[^\\S\\n]+${RULE}`);
const PARSABLE = new RegExp(`^(.+?):(\\d+):(\\d+):[^\\S\\n]+\\[(error|warning)\\][^\\S\\n]+(.+?)[^\\S\\n]+${RULE}`);
// A bare filename, which is what opens a block in the default format.
const FILE = /^(\S.*?)[^\S\n]*$/;

export default {
  name: "yamllint",
  category: "lint",
  commands: ["yamllint"],

  detect: (s) => {
    const lines = s.split("\n");
    return PARSABLE.test(lines.find((l) => PARSABLE.test(l)) ?? "") ||
      // A finding on its own proves nothing about which file it belongs to, so the
      // default format is only claimed when a filename actually opens the block.
      lines.some((l, i) => TTY.test(l) && lines.slice(0, i).some((p) => FILE.test(p) && !TTY.test(p)));
  },

  extract(s) {
    const found = [];
    let file = null;
    for (const line of s.split("\n")) {
      const p = line.match(PARSABLE);
      if (p) { found.push({ file: p[1], line: +p[2], col: +p[3], severity: p[4], message: p[5], code: p[6] }); continue; }
      const t = line.match(TTY);
      if (t) { if (file) found.push({ file, line: +t[1], col: +t[2], severity: t[3], message: t[4], code: t[5] }); continue; }
      if (line.trim() && !/^[^\S\n]/.test(line)) file = line.trim();
    }
    if (!found.length) return null;
    // Unlike shellcheck, yamllint exits zero on a run that found only warnings, so a
    // warning here did not fail anything and reporting one as a failure would be a
    // claim the exit status contradicts. Errors are the whole answer; if there are
    // none, this parser has nothing to say about why the command failed.
    const shown = found.filter((f) => f.severity === "error");
    if (!shown.length) return null;
    const hidden = found.length - shown.length;
    return {
      tool: "yamllint",
      summary: `${shown.length} error${shown.length > 1 ? "s" : ""}` +
        (hidden ? ` — ${hidden} warning${hidden > 1 ? "s" : ""} hidden` : ""),
      failures: shown.map((f) => ({
        file: f.file, line: f.line, col: f.col, title: f.code, code: f.code,
        severity: f.severity, message: f.message,
      })),
    };
  },
};
