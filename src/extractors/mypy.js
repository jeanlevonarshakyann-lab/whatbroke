const MAX_NOTES = 2;
const DIAGNOSTIC_RE = /^(.+?):(\d+)(?::(\d+))?:[^\S\n]+(error|warning|note):[^\S\n]+(.+?)(?:[^\S\n]+\[([^\]]+)\])?$/;
// mypy only ever reports Python source. "file:line: error: message" is not its shape
// alone - javac writes it, and swiftc writes "<unknown>:0: error: ..." when the driver
// has no source to point at, which a mypy run pasted above it claimed as a fourth type
// error. The detect gate already required an extension on the no-summary path; the
// extract had no such gate, so a run carrying "Found N errors" claimed anything.
const PYTHON_SRC = /\.pyi?$/;

export default {
  name: "mypy",
  category: "typecheck",
  commands: ["mypy"],
  detect: (s) =>
    !/(?:clang|gcc|\bg\+\+|cc1|ld:|^> Task .+ FAILED$|^FAILURE: Build failed)/im.test(s) &&
    (/^[^\S\n]*Found \d+ errors? in \d+ files?/m.test(s) ||
      // Python source and stubs can include columns and omit the summary.
      // A bare file:line diagnostic also matches javac, so require an extension.
      /^.+\.pyi?:\d+(?::\d+)?:[^\S\n]+(?:error|warning|note):[^\S\n]+/m.test(s)),

  extract(s) {
    // mypy reports a problem with its own invocation - an unreadable file, a bad flag -
    // as "mypy: error: ...", with no file:line for the diagnostic pattern to find.
    const own = s.match(/^mypy: error: (.+)$/m);
    const lines = s.split("\n");
    const failures = [];
    let warnings = 0;
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(DIAGNOSTIC_RE);
      if (!match || match[4] === "note" || !PYTHON_SRC.test(match[1])) continue;
      if (match[4] === "warning") { warnings++; continue; }
      // A note at the SAME file and line continues this error - for a call-overload
      // failure the notes carry the valid signatures, which is the whole answer.
      // Notes elsewhere are separate remarks and stay out.
      const notes = [];
      for (let j = i + 1; j < lines.length && notes.length < MAX_NOTES; j++) {
        const n = lines[j].match(DIAGNOSTIC_RE);
        if (!n || n[4] !== "note" || n[1] !== match[1] || n[2] !== match[2]) break;
        notes.push(n[5]);
      }
      failures.push({
        file: match[1], line: +match[2], col: match[3] ? +match[3] : undefined,
        title: match[6] ?? "mypy", code: match[6], severity: match[4], 
        message: [match[5], ...notes].join("\n"),
      });
    }
    if (own) {
      failures.push({ title: "mypy", label: "mypy", severity: "error", message: own[1] });
    }
    if (!failures.length) return null;
    const summaryMatch = s.match(/^[^\S\n]*Found (\d+) errors? in (\d+) files?/m);
    const summary = summaryMatch
      ? `${summaryMatch[1]} error${summaryMatch[1] === "1" ? "" : "s"} in ${summaryMatch[2]} file${summaryMatch[2] === "1" ? "" : "s"}`
      : `${failures.length} errors`;
    return {
      tool: "mypy",
      summary: warnings ? `${summary} — ${warnings} warning${warnings > 1 ? "s" : ""} hidden` : summary,
      failures,
    };
  },
};
