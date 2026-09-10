const PROB_RE = /^[^\S\n]+(\d+):(\d+)[^\S\n]+(error|warning)[^\S\n]+(.+?)\s{2,}([\w@/-]+)[^\S\n]*$/;

// eslint reports a broken config by crashing, so the log is a Node stack pointing into
// eslint's own internals - and the node parser then reports node_modules/eslint/lib/... ,
// which is true and useless. The line that matters is the one under the banner.
const CONFIG_BANNER = /^Oops! Something went wrong!/m;
const CONFIG_ERROR = /^([A-Z]\w*Error): (.+)$/;

export default {
  name: "eslint",
  category: "lint",
  commands: ["eslint"],
  detect: (s) => /^[^\S\n]*[✖x][^\S\n]+\d+ problems? \(/m.test(s) || PROB_RE.test(s) ||
    (CONFIG_BANNER.test(s) && /^ESLint: /m.test(s)),

  extract(s) {
    if (CONFIG_BANNER.test(s)) {
      const lines = s.split("\n");
      const banner = lines.findIndex((l) => CONFIG_BANNER.test(l));
      // A previous command may also have thrown a TypeError. ESLint's configuration
      // exception is the first one after its own banner, never before it.
      const relative = lines.slice(banner + 1).findIndex((l) => CONFIG_ERROR.test(l));
      const at = relative < 0 ? -1 : banner + 1 + relative;
      if (at >= 0) {
        const m = lines[at].match(CONFIG_ERROR);
        return {
          tool: "eslint",
          summary: "configuration error",
          failures: [{ title: m[1], code: m[1], severity: "error", message: m[2] }],
        };
      }
    }
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
    const m = s.match(/^[^\S\n]*[✖x][^\S\n]+(\d+ problems? \(.+?\))[^\S\n]*$/m);
    if (m) summary = m[1];
    if (!failures.length) return null;
    if (warnings) summary = `${summary ?? `${failures.length} errors`} — ${warnings} warning${warnings > 1 ? "s" : ""} hidden`;
    return { tool: "eslint", summary, failures };
  },
};
