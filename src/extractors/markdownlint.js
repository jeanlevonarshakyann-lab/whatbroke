// markdownlint writes one line per violation and nothing else:
//
//   doc.md:3:1 error MD018/no-missing-space-atx No space after hash on atx style
//     heading [Context: "#Bad heading"]
//   doc.md:5 MD030/list-marker-space Spaces after list markers [Expected: 1; Actual: 2]
//
// The column and the word "error" are both optional depending on version and flags, so
// what identifies a line is the rule: MD followed by three digits, then a slash and the
// rule's name. Nothing else writes that.
const RULE = "MD\\d{3}";
const VIOLATION_RE = new RegExp(
  `^(\\S.*?):(\\d+)(?::(\\d+))?[^\\S\\n]+(?:error[^\\S\\n]+)?(${RULE})/([\\w-]+)[^\\S\\n]+(.+?)[^\\S\\n]*$`,
);
// The rule's own explanation of what it wanted, which markdownlint appends in brackets.
// Keep it: "[Expected: 1; Actual: 2]" is the whole answer for a spacing rule.
const CONTEXT_RE = /[^\S\n]*\[(?:Context|Expected):[^\]]*\][^\S\n]*$/;

export default {
  name: "markdownlint",
  category: "lint",
  commands: ["markdownlint", "markdownlint-cli2"],

  detect: (s) => new RegExp(`(?:^|[^\\S\\n])${RULE}/[\\w-]`, "m").test(s),

  extract(s) {
    const failures = [];
    const seen = new Set();
    for (const line of s.split("\n")) {
      const m = line.match(VIOLATION_RE);
      if (!m) continue;
      const key = `${m[1]}:${m[2]}:${m[3] ?? ""}:${m[4]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      failures.push({
        file: m[1], line: +m[2], col: m[3] ? +m[3] : undefined,
        title: m[4], code: m[4], severity: "error",
        // the rule's name is in the code's own documentation; the message is the point
        message: m[6].replace(CONTEXT_RE, "").trim() || m[5],
      });
    }
    if (!failures.length) return null;
    const n = failures.length;
    const files = new Set(failures.map((f) => f.file)).size;
    return {
      tool: "markdownlint",
      summary: `${n} problem${n === 1 ? "" : "s"}${files > 1 ? ` in ${files} files` : ""}`,
      failures,
    };
  },
};
