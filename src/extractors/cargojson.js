// `cargo build --message-format=json` and `rustc --error-format=json` emit one JSON
// object per line, and nothing here could read a word of it: a real compile failure came
// back as "could not identify a diagnostic". CI pipelines that post-process cargo's
// output run it this way, and the log they keep is this.
//
// This reads the schema rather than the rendered text. Every diagnostic record does also
// carry a `rendered` field holding exactly what cargo would have printed, and feeding
// that to the text parser was the first thing I tried - but it turns one line into
// several, and every failure's private source range is expected to index the log it was
// given. Reading the record directly keeps one failure on the one line it came from.
import { joinSources, withSource } from "../ownership.js";

const RECORD = /^[^\S\n]*\{.*\}[^\S\n]*$/;

/** The records rustc emits that are not diagnostics: "Some errors have detailed
 *  explanations", "For more information about an error". They carry no span and are
 *  chatter under any format. */
const NOTE_LEVELS = new Set(["note", "help", "failure-note"]);

/** Every diagnostic record, and the line it was written on. */
function diagnostics(s) {
  const out = [];
  const lines = s.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!RECORD.test(lines[i])) continue;
    let record;
    try { record = JSON.parse(lines[i]); } catch { continue; }
    const message = record?.message;
    if (!message || typeof message.message !== "string" || !Array.isArray(message.spans)) continue;
    out.push({ message, at: i });
  }
  return out;
}

export default {
  name: "cargo --message-format=json",
  category: "compile",
  commands: ["cargo", "rustc"],

  // A line of JSON proves nothing on its own - plenty of tools log JSON. A rustc
  // diagnostic record is what this claims: an object carrying a level, a message and a
  // spans array, which together are that schema and not somebody else's.
  detect: (s) => diagnostics(s).some(({ message: m }) => typeof m.level === "string"),

  extract(s) {
    const failures = [];
    let warnings = 0;
    const seen = new Map();
    for (const { message: m, at } of diagnostics(s)) {
      if (NOTE_LEVELS.has(m.level)) continue;
      // cargo compiles a crate once per target that includes it - the binary and its
      // tests, under --all-targets or `cargo test` - and the stream carries one record
      // per compilation. The same two errors arrived four times and the same warning
      // twice, and the summary said "4 errors - 2 warnings hidden" above the two failures
      // that survived. The text form prints each diagnostic once and says "(1 duplicate)"
      // for the rest: two records with the same rendered text are one diagnostic.
      const identity = typeof m.rendered === "string" ? m.rendered
        : JSON.stringify([m.level, m.code?.code, m.message, m.spans.map((sp) => [sp.file_name, sp.line_start, sp.column_start])]);
      // ...and it was read from each of those records.
      if (seen.has(identity)) {
        const index = seen.get(identity);
        if (index !== null) failures[index] = joinSources(failures[index], withSource({}, at, at + 1));
        continue;
      }
      seen.set(identity, m.level === "error" ? failures.length : null);
      if (m.level === "warning") { warnings++; continue; }
      if (m.level !== "error") continue;
      // rustc marks exactly one span as primary: the place it wants you to look. The
      // others are context - "expected due to this" - and belong to the same failure.
      const primary = m.spans.find((sp) => sp.is_primary) ?? m.spans[0];
      const label = primary?.label;
      // The span carries the offending source line itself, so the quoted line is the
      // tool's own text rather than anything reconstructed.
      const stmt = primary?.text?.[0]?.text;
      const code = m.code?.code;
      failures.push(withSource({
        file: primary?.file_name, line: primary?.line_start, col: primary?.column_start,
        title: code ?? "error", ...(code ? { code } : { label: "error" }),
        severity: "error",
        message: [m.message, label].filter(Boolean).join("\n"),
        ...(stmt ? { stmt } : {}),
      }, at, at + 1));
    }
    if (!failures.length) return null;
    const n = failures.length;
    return {
      tool: "cargo",
      summary: `${n} error${n > 1 ? "s" : ""}` +
        (warnings ? ` — ${warnings} warning${warnings > 1 ? "s" : ""} hidden` : ""),
      failures,
    };
  },
};
