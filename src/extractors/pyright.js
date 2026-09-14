import { jsonDocuments, jsonDocumentsAt } from "../util.js";
import { withSource } from "../ownership.js";
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

// `pyright --outputjson` - and basedpyright's - writes the same run as a document, which
// is what an editor integration or a CI annotation step reads. Nothing read it: three
// errors came back as no diagnosis at all.
//
//   { "version": "1.1.414", "generalDiagnostics": [
//       { "file": "/app/bad.py", "severity": "error",
//         "message": "Type \"int\" is not assignable to return type \"str\"\n  \"int\" is ...",
//         "range": { "start": { "line": 1, "character": 11 }, ... }, "rule": "reportReturnType" } ],
//     "summary": { "filesAnalyzed": 1, "errorCount": 3, "warningCount": 1, ... } }
//
// The document counts lines and characters from zero, where the text form counts both
// from one; its message is the heading and the explanation the text form indents under
// it, and its rule is a field rather than the end of the explanation.
const REPORT = (v) => !!v && typeof v === "object" && Array.isArray(v.generalDiagnostics) &&
  !!v.summary && ["errorCount", "warningCount", "informationCount"].every((k) => Number.isInteger(v.summary[k]));

function jsonReports(s) {
  return s.includes('"generalDiagnostics"') ? [...jsonDocuments(s, REPORT)] : [];
}

export default {
  name: "pyright",
  // Strings a log has to hold for this parser to read anything from it - see src/router.js.
  signals: ["information", "error:", "warning:", "\"generalDiagnostics\""],
  category: "typecheck",
  commands: ["pyright", "basedpyright"],

  detect: (s) => TALLY_RE.test(s) || DIAG_RE.test(s.split("\n").find((l) => DIAG_RE.test(l)) ?? "") ||
    jsonReports(s).some((r) => r.summary.errorCount > 0),

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
      // The diagnostic and the explanation indented under it.
      failures.push(withSource({
        file: m[1], line: +m[2], col: +m[3],
        title: rule ?? "error", ...(rule ? { code: rule } : { label: "error" }),
        severity: "error",
        message: [head, ...detail].filter(Boolean).join("\n"),
      }, i, i + 1 + detail.length));
    }
    const reports = s.includes('"generalDiagnostics"') ? [...jsonDocumentsAt(s, REPORT)] : [];
    let reportedWarnings = 0;
    for (const { value: report, where } of reports) {
      reportedWarnings += report.summary.warningCount;
      for (const d of report.generalDiagnostics) {
        if (d?.severity !== "error" || typeof d.file !== "string" || typeof d.message !== "string") continue;
        const start = d.range?.start;
        const [head, ...detail] = d.message.split("\n").map((l) => l.trim()).filter(Boolean);
        const rule = typeof d.rule === "string" && d.rule ? d.rule : undefined;
        const place = where(d);
        failures.push(withSource({
          file: d.file,
          line: Number.isInteger(start?.line) ? start.line + 1 : undefined,
          col: Number.isInteger(start?.character) ? start.character + 1 : undefined,
          title: rule ?? "error", ...(rule ? { code: rule } : { label: "error" }),
          severity: "error",
          message: [head, ...detail.slice(0, MAX_DETAIL)].filter(Boolean).join("\n"),
        }, place.start, place.end));
      }
    }
    if (!failures.length) return null;
    const tally = s.match(TALLY_RE);
    // A log holding only the document has no tally line; the document counts the same
    // things, run by run.
    const counted = reports.length && !tally
      ? { errors: reports.reduce((n, r) => n + r.value.summary.errorCount, 0), warnings: reportedWarnings }
      : null;
    const hidden = Number(tally?.[2] ?? counted?.warnings ?? warnings);
    const n = Number(tally?.[1] ?? counted?.errors ?? failures.length);
    return {
      tool: "pyright",
      summary: `${n} error${n === 1 ? "" : "s"}` +
        (hidden ? ` — ${hidden} warning${hidden > 1 ? "s" : ""} hidden` : ""),
      failures,
    };
  },
};
