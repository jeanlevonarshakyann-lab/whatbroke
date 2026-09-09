const MAX_NOTES = 2;
const DIAGNOSTIC_RE = /^(.+?):(\d+)(?::(\d+))?:[ \t]+(error|warning|note):[ \t]+(.+?)(?:[ \t]+\[([^\]]+)\])?$/;

export default {
  name: "mypy",
  detect: (s) =>
    !/(?:clang|gcc|\bg\+\+|cc1|ld:|^> Task .+ FAILED$|^FAILURE: Build failed)/im.test(s) &&
    (/^[ \t]*Found \d+ errors? in \d+ files?/m.test(s) ||
      // Python source and stubs can include columns and omit the summary.
      // A bare file:line diagnostic also matches javac, so require an extension.
      /^.+\.pyi?:\d+(?::\d+)?:[ \t]+(?:error|warning|note):[ \t]+/m.test(s)),

  extract(s) {
    const lines = s.split("\n");
    const failures = [];
    let warnings = 0;
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(DIAGNOSTIC_RE);
      if (!match || match[4] === "note") continue;
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
    if (!failures.length) return null;
    const summaryMatch = s.match(/^[ \t]*Found (\d+) errors? in (\d+) files?/m);
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
