const DIAGNOSTIC_RE = /^(.+?):(\d+):(\d+):\s+(error|fatal error|warning|note):\s+(.+)$/;
const CODE_RE = /\s+\[(-W[\w-]+)\]$/;

export default {
  name: "clang",
  detect: (s) =>
    /^\S.+:\d+:\d+:\s+(?:error|fatal error|warning|note):\s+/m.test(s) &&
    /(?:clang|gcc|g\+\+|cc1|ld:)/i.test(s),

  extract(s) {
    const failures = [];
    let warnings = 0;
    for (const line of s.split("\n")) {
      const match = line.match(DIAGNOSTIC_RE);
      if (!match || match[4] === "note") continue;
      const code = match[5].match(CODE_RE);
      const message = code ? match[5].replace(CODE_RE, "") : match[5];
      if (match[4] === "warning") { warnings++; continue; }
      failures.push({
        file: match[1], line: +match[2], col: +match[3],
        title: code?.[1] ?? match[4], message,
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
