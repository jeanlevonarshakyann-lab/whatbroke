const LOCATION_RE = /^\s*(.+?):(\d+)$/;

export default {
  name: "phpunit",
  detect: (s) =>
    /There (?:was|were) \d+ failure/.test(s) &&
    /^\d+\)\s+[\w\\]+::\w+/m.test(s),

  extract(s) {
    const lines = s.split("\n");
    const failures = [];
    for (let i = 0; i < lines.length; i++) {
      const header = lines[i].match(/^\d+\)\s+(.+)$/);
      if (!header) continue;
      const message = [];
      let file;
      let line;
      for (let j = i + 1; j < lines.length &&
        !/^\d+\)\s+/.test(lines[j]) &&
        !/^\s*(?:Tests:|Time:|OK\b|FAILURES!)/.test(lines[j]); j++) {
        const location = lines[j].match(LOCATION_RE);
        if (location && /\.[a-z]+$/i.test(location[1])) {
          file = location[1];
          line = +location[2];
        } else if (lines[j].trim()) {
          message.push(lines[j].trim());
        }
      }
      failures.push({ file, line, title: header[1], message: message.join("\n") });
    }
    if (!failures.length) return null;
    const summaryMatch = s.match(/Tests:\s+.*?(\d+) failed/);
    return {
      tool: "phpunit",
      summary: summaryMatch ? `${summaryMatch[1]} failures` : `${failures.length} failures`,
      failures,
    };
  },
};
