const DIAGNOSTIC_RE = /^(.+?):(\d+):(\d+):[^\S\n]+(error|fatal error|warning|note):[^\S\n]+(.+)$/;
const CODE_RE = /[^\S\n]+\[(-W[\w-]+)\]$/;
// The driver speaks for itself when there is no source to point at: a missing input, an
// unknown flag, a failed link. These carry no file:line, so the pattern above never sees
// them and a `make` run that could not even start compiling fell through to a guess.
const DRIVER_RE = /^(clang(?:\+\+)?|gcc|g\+\+|cc|ld|cc1(?:plus)?):[^\S\n]+(error|fatal error):[^\S\n]+(.+)$/;

export default {
  name: "clang",
  category: "compile",
  commands: ["clang", "clang++", "gcc", "g++", "cc", "make"],
  detect: (s) =>
    (/^\S.+:\d+:\d+:[^\S\n]+(?:error|fatal error|warning|note):[^\S\n]+/m.test(s) &&
     /(?:clang|gcc|g\+\+|cc1|ld:|[\w.-]+\.(?:c|cc|cpp|cxx|h|hpp|m|mm):)/i.test(s)) ||
    // A driver error names the driver, which is as specific as the pattern above.
    DRIVER_RE.test(s.split("\n").find((l) => DRIVER_RE.test(l)) ?? ""),

  extract(s) {
    const failures = [];
    let warnings = 0;
    for (const line of s.split("\n")) {
      const driver = line.match(DRIVER_RE);
      if (driver) {
        // "no input files" only restates the failure above it; the first one is the cause.
        if (!/^no input files$/.test(driver[3])) {
          failures.push({ title: driver[2], label: driver[2], severity: "error", message: driver[3] });
        }
        continue;
      }
      const match = line.match(DIAGNOSTIC_RE);
      if (!match || match[4] === "note") continue;
      const code = match[5].match(CODE_RE);
      const message = code ? match[5].replace(CODE_RE, "") : match[5];
      if (match[4] === "warning") { warnings++; continue; }
      failures.push({
        file: match[1], line: +match[2], col: +match[3],
        title: code?.[1] ?? match[4], code: code?.[1], label: code ? undefined : match[4], severity: match[4], message,
      });
    }
    if (!failures.length) return null;
    return {
      tool: "clang",
      summary: `${failures.length} error${failures.length > 1 ? "s" : ""}` +
        (warnings ? ` — ${warnings} warning${warnings > 1 ? "s" : ""} hidden` : ""),
      failures,
    };
  },
};
