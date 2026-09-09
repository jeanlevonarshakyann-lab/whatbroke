const DIAGNOSTIC_RE = /^(.+?\.(?:cs|fs|vb))\((\d+),(\d+)\):[^\S\n]+(error|warning)[^\S\n]+([A-Z]\w*\d+):[^\S\n]+(.+)$/m;
// Not every .NET failure comes from the compiler. A missing project file and a package
// that will not restore are both reported by MSBuild or NuGet with a code but no
// position - "app.csproj : error NU1101: ..." , "MSBUILD : error MSB1003: ..." - and
// requiring a position meant two of the commonest .NET failures produced nothing at all.
const PROJECT_RE = /^(\S.*?)[^\S\n]+:[^\S\n]+(error|warning)[^\S\n]+((?:MSB|NU|NETSDK)\d+):[^\S\n]+(.+)$/;

export default {
  name: "dotnet",
  category: "compile",
  commands: ["dotnet", "msbuild"],
  // A --no-restore build has no restore banner. Source extensions distinguish
  // these diagnostics from TypeScript's otherwise identical location syntax.
  detect: (s) => DIAGNOSTIC_RE.test(s) ||
    s.split("\n").some((l) => PROJECT_RE.test(l)),

  extract(s) {
    const failures = [];
    const seen = new Set();
    let warnings = 0;
    for (const line of s.split("\n")) {
      const project = line.match(PROJECT_RE);
      if (project) {
        // The same restore error is printed once as it happens and again in the
        // "Build FAILED." summary.
        const f = {
          // MSBUILD is the tool speaking, not a file that can be opened.
          file: /^MSBUILD$/i.test(project[1]) ? undefined : project[1],
          title: project[3], code: project[3], severity: "error", message: project[4].trim(),
        };
        const k = JSON.stringify(f);
        if (project[2] === "warning") { if (!seen.has(`w:${k}`)) warnings++; seen.add(`w:${k}`); continue; }
        if (!seen.has(k)) { seen.add(k); failures.push(f); }
        continue;
      }
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
