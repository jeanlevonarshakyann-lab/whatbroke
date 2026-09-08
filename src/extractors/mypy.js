const DIAGNOSTIC_RE = /^(.+?):(\d+)(?::(\d+))?:\s+(error|warning|note):\s+(.+?)(?:\s+\[([^\]]+)\])?$/;

export default {
  name: "mypy",
  detect: (s) =>
    !/(?:clang|gcc|\bg\+\+|cc1|ld:|^> Task .+ FAILED$|^FAILURE: Build failed)/im.test(s) &&
    !/^\S.+:\d+:\d+:\s+(?:error|warning|note):\s+/m.test(s) &&
    (/^\s*Found \d+ errors? in \d+ files?/m.test(s) ||
      /^\S.+:\d+(?::\d+)?:\s+(?:error|warning|note):\s+/m.test(s)),

  extract(s) {
    const lines = s.split("\n");
    const failures = [];
    let warnings = 0;
    for (const line of lines) {
      const match = line.match(DIAGNOSTIC_RE);
      if (!match || match[4] === "note") continue;
      if (match[4] === "warning") { warnings++; continue; }
      failures.push({
        file: match[1], line: +match[2], col: match[3] ? +match[3] : undefined,
        title: match[6] ?? "mypy",
        message: match[5],
      });
    }
    if (!failures.length) return null;
    const summaryMatch = s.match(/^\s*Found (\d+) errors? in (\d+) files?/m);
    const summary = summaryMatch
      ? `${summaryMatch[1]} errors in ${summaryMatch[2]} files`
      : `${failures.length} errors`;
    return {
      tool: "mypy",
      summary: warnings ? `${summary} — ${warnings} warning${warnings > 1 ? "s" : ""} hidden` : summary,
      failures,
    };
  },
};
