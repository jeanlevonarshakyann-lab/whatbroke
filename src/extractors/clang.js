const DIAGNOSTIC_RE = /^(.+?):(\d+):(\d+):[^\S\n]+(error|fatal error|warning|note):[^\S\n]+(.+)$/;
const CODE_RE = /[^\S\n]+\[(-W[\w-]+)\]$/;

export default {
  name: "clang",
  category: "compile",
  commands: ["clang", "clang++", "gcc", "g++", "cc", "make"],
  detect: (s) =>
    /^\S.+:\d+:\d+:[^\S\n]+(?:error|fatal error|warning|note):[^\S\n]+/m.test(s) &&
    /(?:clang|gcc|g\+\+|cc1|ld:|[\w.-]+\.(?:c|cc|cpp|cxx|h|hpp|m|mm):)/i.test(s),

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
