// ruff emits rustc-style diagnostics: a header line, then " --> file:line:col".
const HEAD_RE = /^([A-Z]+\d+)(?:[ \t]+\[[*x]\])?[ \t]+(.+)$/;
const ARROW_RE = /^[ \t]*-->[ \t]+(.+?):(\d+):(\d+)[ \t]*$/;

export default {
  name: "ruff",
  detect: (s) => /^Found \d+ errors?\.?$/m.test(s) && /^[ \t]*-->\s/m.test(s),

  extract(s) {
    const lines = s.split("\n");
    const failures = [];
    for (let i = 0; i < lines.length; i++) {
      const h = lines[i].match(HEAD_RE);
      if (!h) continue;
      const a = lines[i + 1]?.match(ARROW_RE);
      if (!a) continue;                       // a header with no location isn't a diagnostic
      let fix = "";
      for (let j = i + 2; j < lines.length && !HEAD_RE.test(lines[j]); j++) {
        const f = lines[j].match(/^[ \t]*help:[ \t]*(.+)$/);
        if (f) { fix = f[1]; break; }
      }
      failures.push({
        file: a[1], line: +a[2], col: +a[3],
        title: h[1], code: h[1], severity: "error", message: [h[2], fix].filter(Boolean).join("\n"),
      });
      i++;
    }
    if (!failures.length) return null;
    const sm = s.match(/^Found (\d+) errors?\.?$/m);
    return { tool: "ruff", summary: `${sm ? sm[1] : failures.length} errors`, failures };
  },
};
