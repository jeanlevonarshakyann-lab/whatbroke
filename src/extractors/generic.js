/** Last resort: no parser matched. Surface the lines most likely to matter. */
const SIGNAL = [
  /^[^\S\n]*(error|fatal|panic|exception)\b/i,
  /\b(Error|Exception|Panic|Assertion\w*)[^\S\n]*:/,
  /^[^\S\n]*(FAIL|FAILED|✗|✖|×)\b/,
  /^[^\s:]+:\d+(:\d+)?:\s/,
  // The classic unix shape - "curl: (7) Failed to connect", "cp: cannot stat",
  // "ssh: ... Connection refused". A bare "prog: message" is far too broad to
  // treat as an error, so it must also say that something did not work.
  /^[a-z][\w.+-]*:\s.*\b(?:failed|failure|cannot|can't|not found|refused|denied|no such|unable to|invalid|missing|timed out|unreachable|does not exist|permission)\b/i,
];
const NOISE = [/^[^\S\n]*at /, /^npm (notice|warn)/, /^[^\S\n]*$/, /^warning:/i];

export default {
  name: "generic",
  category: "unknown",
  commands: [],
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
      const loc = h.text.match(/^([^\s:]+):(\d+)(?::(\d+))?:[^\S\n]*(.*)$/);
      failures.push(loc
        ? { file: loc[1], line: +loc[2], col: loc[3] ? +loc[3] : undefined, title: "", severity: "error", message: loc[4] }
        : { title: "", severity: "error", message: h.text });
    }
    return { tool: "output", failures, guessed: true };
  },
};
