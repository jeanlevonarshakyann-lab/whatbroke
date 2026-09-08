const PROB_RE = /^\s+(\d+):(\d+)\s+(error|warning)\s+(.+?)\s{2,}([\w@/-]+)\s*$/;

export default {
  name: "eslint",
  detect: (s) => /^\s*[✖x]\s+\d+ problems? \(/m.test(s) || PROB_RE.test(s),

  extract(s) {
    const lines = s.split("\n");
    const failures = [];
    let file = null, warnings = 0;

    for (const l of lines) {
      const p = l.match(PROB_RE);
      if (p) {
        if (p[3] === "warning") { warnings++; continue; }   // errors are what block you
        failures.push({ file, line: +p[1], col: +p[2], title: p[5], message: p[4] });
        continue;
      }
      if (l.trim() && !/^\s/.test(l) && !/^[✖x✔]/.test(l.trim())) file = l.trim();
    }

    let summary;
    const m = s.match(/^\s*[✖x]\s+(\d+ problems? \(.+?\))\s*$/m);
    if (m) summary = m[1];
    if (!failures.length) return null;
    if (warnings) summary = `${summary ?? `${failures.length} errors`} — ${warnings} warning${warnings > 1 ? "s" : ""} hidden`;
    return { tool: "eslint", summary, failures };
  },
};
