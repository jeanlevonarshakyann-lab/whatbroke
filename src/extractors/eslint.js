const PROB_RE = /^[ \t]+(\d+):(\d+)[ \t]+(error|warning)[ \t]+(.+?)\s{2,}([\w@/-]+)[ \t]*$/;

export default {
  name: "eslint",
  category: "lint",
  commands: ["eslint"],
  detect: (s) => /^[ \t]*[✖x][ \t]+\d+ problems? \(/m.test(s) || PROB_RE.test(s),

  extract(s) {
    const lines = s.split("\n");
    const failures = [];
    let file = null, warnings = 0;

    for (const l of lines) {
      const p = l.match(PROB_RE);
      if (p) {
        if (p[3] === "warning") { warnings++; continue; }   // errors are what block you
        failures.push({ file, line: +p[1], col: +p[2], title: p[5], code: p[5], severity: p[3], message: p[4] });
        continue;
      }
      if (l.trim() && !/^\s/.test(l) && !/^[✖x✔]/.test(l.trim())) file = l.trim();
    }

    let summary;
    const m = s.match(/^[ \t]*[✖x][ \t]+(\d+ problems? \(.+?\))[ \t]*$/m);
    if (m) summary = m[1];
    if (!failures.length) return null;
    if (warnings) summary = `${summary ?? `${failures.length} errors`} — ${warnings} warning${warnings > 1 ? "s" : ""} hidden`;
    return { tool: "eslint", summary, failures };
  },
};
