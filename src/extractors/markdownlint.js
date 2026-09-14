import { findJsonDocument, jsonDocumentsAt } from "../util.js";
import { joinSources, withSource } from "../ownership.js";
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
  // A rule can carry more than one alias - "MD041/first-line-heading/first-line-h1" -
  // and matching only the first dropped that violation silently: five findings in the
  // log, four reported, with no sign that one had gone.
  `^(\\S.*?):(\\d+)(?::(\\d+))?[^\\S\\n]+(?:error[^\\S\\n]+)?(${RULE})/([\\w-]+(?:/[\\w-]+)*)[^\\S\\n]+(.+?)[^\\S\\n]*$`,
);
// markdownlint appends one bracket to the text, and which one it is decides whether the
// bracket is worth keeping. [Context: "..."] quotes the offending line, which the file
// and line already point at. [Expected: 1; Actual: 2] is the whole answer for a spacing
// rule, and dropping it with the context left the reader the rule name and nothing else.
// --json writes the same violations as records: the rule's aliases in an array, the
// description apart from the detail, and the line with no column at all.
const JSON_MARK = (v) => Array.isArray(v) && v.length > 0 &&
  v.every((r) => r && typeof r.fileName === "string" && Number.isInteger(r.lineNumber) && Array.isArray(r.ruleNames));

const CONTEXT_RE = /[^\S\n]*\[Context:[^\]]*\][^\S\n]*$/;

export default {
  name: "markdownlint",
  category: "lint",
  commands: ["markdownlint", "markdownlint-cli2"],

  detect: (s) => new RegExp(`(?:^|[^\\S\\n])${RULE}/[\\w-]`, "m").test(s) ||
    findJsonDocument(s, JSON_MARK) !== null,

  extract(s) {
    const failures = [];
    const seen = new Map();
    const lines = s.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(VIOLATION_RE);
      if (!m) continue;
      const key = `${m[1]}:${m[2]}:${m[3] ?? ""}:${m[4]}`;
      const failure = withSource({
        file: m[1], line: +m[2], col: m[3] ? +m[3] : undefined,
        title: m[4], code: m[4], severity: "error",
        // the rule's name is in the code's own documentation; the message is the point
        message: m[6].replace(CONTEXT_RE, "").trim() || m[5],
      }, i, i + 1);
      if (seen.has(key)) { failures[seen.get(key)] = joinSources(failures[seen.get(key)], failure); continue; }
      seen.set(key, failures.length);
      failures.push(failure);
    }
    // --json: the same violations as records. Read whatever the text form gave, since a
    // log can hold both, and a violation already reported is not added twice - it keeps
    // the place it was reported in as well.
    for (const { value: records, where } of jsonDocumentsAt(s, JSON_MARK)) {
      for (const r of records) {
        const code = r.ruleNames[0];
        const key = `${r.fileName}:${r.lineNumber}::${code}`;
        const place = where(r);
        const failure = withSource({
          file: r.fileName, line: r.lineNumber,
          col: Array.isArray(r.errorRange) ? r.errorRange[0] : undefined,
          title: code, code, severity: "error",
          // Worded exactly as the text form words it, so one run printed both ways is one
          // failure rather than two that differ in punctuation.
          message: r.errorDetail ? `${r.ruleDescription} [${r.errorDetail}]` : r.ruleDescription,
        }, place.start, place.end);
        const earlier = seen.has(key) ? seen.get(key)
          : failures.findIndex((f) => f.file === r.fileName && f.line === r.lineNumber && f.code === code);
        if (earlier >= 0) { failures[earlier] = joinSources(failures[earlier], failure); continue; }
        seen.set(key, failures.length);
        failures.push(failure);
      }
      break;
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
