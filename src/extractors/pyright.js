// pyright indents each diagnostic under the file it belongs to, puts the column after
// the line with a dash between location and severity, and names the rule in brackets at
// the end of an indented explanation below:
//
//   /app/bad.py
//     /app/bad.py:2:12 - error: Type "int" is not assignable to return type "str"
//       "int" is not assignable to "str" (reportReturnType)
//
// The fallback read the file and line and then took the column for the start of the
// message, dropped the explanation, and never saw the rule name at all.
const DIAG_RE = /^[^\S\n]*(\S.*?):(\d+):(\d+)[^\S\n]+-[^\S\n]+(error|warning|information):[^\S\n]+(.+)$/;
const TALLY_RE = /^(\d+) errors?, (\d+) warnings?, (\d+) informations?$/m;
// The rule is the last parenthesised word of the explanation, and it is what you would
// search for or put in a suppression comment.
const RULE_RE = /\((report[A-Za-z]+)\)[^\S\n]*$/;
const MAX_DETAIL = 3;

export default {
  name: "pyright",
  category: "typecheck",
  commands: ["pyright", "basedpyright"],

  detect: (s) => TALLY_RE.test(s) || DIAG_RE.test(s.split("\n").find((l) => DIAG_RE.test(l)) ?? ""),

  extract(s) {
    const lines = s.split("\n");
    const failures = [];
    let warnings = 0;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(DIAG_RE);
      if (!m) continue;
      const indent = lines[i].search(/\S/);
      const detail = [];
      let rule;
      for (let j = i + 1; j < lines.length && detail.length < MAX_DETAIL; j++) {
        if (DIAG_RE.test(lines[j])) break;
        const deeper = lines[j].search(/\S/) > indent;
        if (!deeper || !lines[j].trim()) break;
        const text = lines[j].trim();
        rule ??= text.match(RULE_RE)?.[1];
        detail.push(text.replace(RULE_RE, "").trim());
      }
      if (m[4] !== "error") { warnings += m[4] === "warning" ? 1 : 0; continue; }
      // A one-line diagnostic carries its rule at the end of the message instead, with
      // no explanation under it to hold the name.
      rule ??= m[5].match(RULE_RE)?.[1];
      const head = m[5].replace(RULE_RE, "").trim();
      failures.push({
        file: m[1], line: +m[2], col: +m[3],
        title: rule ?? "error", ...(rule ? { code: rule } : { label: "error" }),
        severity: "error",
        message: [head, ...detail].filter(Boolean).join("\n"),
      });
    }
    if (!failures.length) return null;
    const tally = s.match(TALLY_RE);
    const hidden = Number(tally?.[2] ?? warnings);
    const n = Number(tally?.[1] ?? failures.length);
    return {
      tool: "pyright",
      summary: `${n} error${n === 1 ? "" : "s"}` +
        (hidden ? ` — ${hidden} warning${hidden > 1 ? "s" : ""} hidden` : ""),
      failures,
    };
  },
};
