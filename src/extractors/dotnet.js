const DIAGNOSTIC_RE = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+([A-Z]\w*\d+):\s+(.+)$/;

export default {
  name: "dotnet",
  detect: (s) =>
    /^\s*Determining projects to restore\.\.\./m.test(s) &&
    /^\S.+\(\d+,\d+\):\s+(?:error|warning)\s+[A-Z]\w*\d+:/m.test(s),

  extract(s) {
    const failures = [];
    let warnings = 0;
    for (const line of s.split("\n")) {
      const match = line.match(DIAGNOSTIC_RE);
      if (!match) continue;
      const message = match[6].replace(/\s+\[[^\]]+\.csproj\]\s*$/, "");
      if (match[4] === "warning") { warnings++; continue; }
      failures.push({
        file: match[1], line: +match[2], col: +match[3],
        title: match[5], message,
      });
    }
    if (!failures.length) return null;
    return {
      tool: "dotnet",
      summary: `${failures.length} error${failures.length > 1 ? "s" : ""}` +
        (warnings ? ` — ${warnings} warning${warnings > 1 ? "s" : ""} hidden` : ""),
      failures,
    };
  },
};
