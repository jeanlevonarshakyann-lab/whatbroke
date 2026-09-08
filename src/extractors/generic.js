/** Last resort: no parser matched. Surface the lines most likely to matter. */
const SIGNAL = [
  /^\s*(error|fatal|panic|exception)\b/i,
  /\b(Error|Exception|Panic|Assertion\w*)\s*:/,
  /^\s*(FAIL|FAILED|✗|✖|×)\b/,
  /^[^\s:]+:\d+(:\d+)?:\s/,
];
const NOISE = [/^\s*at /, /^npm (notice|warn)/, /^\s*$/, /^warning:/i];

export default {
  name: "generic",
  detect: () => true,
  extract(s) {
    const lines = s.split("\n");
    const hits = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (NOISE.some((r) => r.test(l))) continue;
      if (SIGNAL.some((r) => r.test(l))) hits.push({ i, text: l.trim() });
    }
    if (!hits.length) return null;
    const seen = new Set();
    const failures = [];
    for (const h of hits.slice(0, 8)) {
      if (seen.has(h.text)) continue;
      seen.add(h.text);
      const loc = h.text.match(/^([^\s:]+):(\d+)(?::(\d+))?:\s*(.*)$/);
      failures.push(loc
        ? { file: loc[1], line: +loc[2], col: loc[3] ? +loc[3] : undefined, title: "", message: loc[4] }
        : { title: "", message: h.text });
    }
    return { tool: "output", failures, guessed: true };
  },
};
