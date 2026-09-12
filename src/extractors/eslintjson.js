// `eslint -f json` is what a pipeline uses when something downstream will read the
// result, and the log it leaves behind is a single line of JSON that nothing here could
// read: six real errors came back as "could not identify a diagnostic".
//
// Like rustc's JSON this is read from the schema rather than from any rendered text -
// eslint does not provide one - and the whole document is one line, so every failure's
// private source range is that line, which is exactly where it came from.
//
// severity is eslint's own: 2 is what fails a run, 1 is a warning and does not, which is
// the same line the text parser draws.
// eslint's json formatter writes the whole document on ONE line, which is what makes it
// findable inside a bigger log: a package runner prints its own banner above the output
// ("Resolving dependencies", "> lint@1.0.0 lint") and a job may hold more than one run.
// Reading line by line finds the report wherever it sits, where parsing the whole log as
// a document found nothing the moment anything else was printed alongside it.
// `-f json` writes a bare array; `-f json-with-metadata` wraps the same array in an
// object alongside the rule metadata. Requiring a bracketed line meant the second form
// was not read at all.
const LOOKS_LIKE = /^[^\S\n]*[[{].*[\]}][^\S\n]*$/;

function results(s) {
  // Parsing a document to decide whether to claim it is worth avoiding when the answer
  // is obviously no, and "a bracketed line mentioning filePath" is nearly free.
  if (!s.includes('"filePath"')) return null;
  const out = [];
  for (const line of s.split("\n")) {
    if (!LOOKS_LIKE.test(line) || !line.includes('"filePath"')) continue;
    let parsed;
    try { parsed = JSON.parse(line); } catch { continue; }
    const list = Array.isArray(parsed) ? parsed
      : (parsed && Array.isArray(parsed.results) ? parsed.results : null);
    if (!list?.length) continue;
    parsed = list;
    if (!parsed.every((r) => r && typeof r.filePath === "string" && Array.isArray(r.messages))) continue;
    out.push(...parsed);
  }
  return out.length ? out : null;
}

export default {
  name: "eslint -f json",
  category: "lint",
  commands: ["eslint"],

  detect: (s) => results(s) !== null,

  extract(s) {
    const files = results(s);
    if (!files) return null;
    const failures = [];
    let warnings = 0;
    for (const file of files) {
      for (const m of file.messages) {
        if (m.severity !== 2) { if (m.severity === 1) warnings++; continue; }
        // A fatal message is a file eslint could not parse at all. It carries no rule,
        // because no rule ran.
        const rule = typeof m.ruleId === "string" ? m.ruleId : null;
        failures.push({
          file: file.filePath, line: m.line, col: m.column,
          title: rule ?? (m.fatal ? "parse error" : "error"),
          ...(rule ? { code: rule } : { label: m.fatal ? "parse error" : "error" }),
          severity: "error", message: String(m.message ?? "").trim(),
        });
      }
    }
    if (!failures.length) return null;
    const n = failures.length;
    // eslint's own headline, in eslint's own words.
    const total = n + warnings;
    return {
      tool: "eslint",
      summary: `${total} problem${total === 1 ? "" : "s"} (${n} error${n === 1 ? "" : "s"}, ` +
        `${warnings} warning${warnings === 1 ? "" : "s"})`,
      failures,
    };
  },
};
