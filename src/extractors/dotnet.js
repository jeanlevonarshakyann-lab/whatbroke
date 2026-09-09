const DIAGNOSTIC_RE = /^(.+?\.(?:cs|fs|vb))\((\d+),(\d+)\):[^\S\n]+(error|warning)[^\S\n]+([A-Z]\w*\d+):[^\S\n]+(.+)$/m;

export default {
  name: "dotnet",
  category: "compile",
  commands: ["dotnet", "msbuild"],
  // A --no-restore build has no restore banner. Source extensions distinguish
  // these diagnostics from TypeScript's otherwise identical location syntax.
  detect: (s) => DIAGNOSTIC_RE.test(s),

  extract(s) {
    const failures = [];
    const seen = new Set();
    let warnings = 0;
    for (const line of s.split("\n")) {
      const match = line.match(DIAGNOSTIC_RE);
      if (!match) continue;
      const message = match[6].replace(/[^\S\n]+\[[^\]]+\.csproj\][^\S\n]*$/, "");
      const failure = {
        file: match[1], line: +match[2], col: +match[3],
        title: match[5], code: match[5], severity: "error", message,
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
