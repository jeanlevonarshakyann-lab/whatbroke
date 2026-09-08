const FAIL_RE = /^\s*FAIL\s+(.+?)\s+>\s+(.+?)\s*$/;
const LOC_RE = /^\s*[❯>]\s+(.+?):(\d+):(\d+)\s*$/;
const SEP_RE = /^[⎯─-╿\s]*(?:\[\d+\/\d+\])?[⎯─-╿\s]*$/;

export default {
  name: "vitest",
  detect: (s) => /^\s*RUN\s+v\d/m.test(s) || /Failed Tests \d+/.test(s) || FAIL_RE.test(s),

  extract(s) {
    const lines = s.split("\n");
    const failures = [];

    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(FAIL_RE);
      if (!m) continue;
      const [, file, title] = m;

      let message = "", loc = null;
      const diff = [];
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j];
        if (FAIL_RE.test(l)) break;
        const lm = l.match(LOC_RE);
        if (lm) { loc = { file: lm[1], line: +lm[2], col: +lm[3] }; break; }
        if (!message && l.trim() && !SEP_RE.test(l)) { message = l.trim(); continue; }
        // vitest prints a "- Expected / + Received" diff; keep the values, drop the header
        // vitest labels its diff "- Expected:" / "+ Received:" - with a colon. Keeping
        // those headers without their values promises a diff and shows none.
        if (/^\s*[-+]\s*\S/.test(l) && !/^[-+]\s*(Expected|Received):?\s*$/.test(l.trim())) {
          diff.push(l.trim());
        }
      }
      if (!message) continue;
      failures.push({
        file: loc?.file ?? file, line: loc?.line, col: loc?.col,
        title, message: [message, ...diff.slice(0, 4)].join("\n"),
      });
    }

    let summary;
    for (const l of lines) {
      const m = l.match(/^\s*Tests\s+(.+?)\s*$/);
      if (m) { summary = m[1]; break; }
    }
    if (!failures.length) return null;
    return { tool: "vitest", summary, failures };
  },
};
