const DIAGNOSTIC_RE = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+([A-Z]\w*\d+):\s+(.+)$/;

export default {
  name: "dotnet",
  detect: (s) =>
    /^\s*Determining projects to restore\.\.\./m.test(s) &&
    /^\S.+\(\d+,\d+\):\s+(?:error|warning)\s+[A-Z]\w*\d+:/m.test(s),

  extract(s) {
    const failures = [];
    const seen = new Set();
    let warnings = 0;
    for (const line of s.split("\n")) {
      const match = line.match(DIAGNOSTIC_RE);
      if (!match) continue;
      const message = match[6].replace(/\s+\[[^\]]+\.csproj\]\s*$/, "");
      const failure = {
        file: match[1], line: +match[2], col: +match[3],
        title: match[5], message,
      };
      const key = JSON.stringify(failure);
      if (match[4] === "warning") {
        if (!seen.has(`warning:${key}`)) warnings++;
        seen.add(`warning:${key}`);
        continue;
      }
      if (seen.has(key)) continue;
      seen.add(key);
      failures.push(failure);
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
