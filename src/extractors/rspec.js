const LOCATION_RE = /^[ \t]+#[ \t]+(.+):(\d+):in\b/;

export default {
  name: "rspec",
  detect: (s) =>
    /^[ \t]+\d+\) /m.test(s) &&
    (/Finished in .+ seconds?/m.test(s) || /^\d+ examples?, \d+ failures?/m.test(s)),

  extract(s) {
    const lines = s.split("\n");
    const failures = [];
    for (let i = 0; i < lines.length; i++) {
      const header = lines[i].match(/^[ \t]+\d+\)[ \t]+(.+)$/);
      if (!header) continue;
      let message = [];
      let file;
      let line;
      for (let j = i + 1; j < lines.length &&
        !/^[ \t]+\d+\)[ \t]+/.test(lines[j]) &&
        !/^Finished in /.test(lines[j]) &&
        !/^Top \d+ slowest/.test(lines[j]) &&
        !/^Failed examples:/.test(lines[j]); j++) {
        const location = lines[j].match(LOCATION_RE);
        if (location) { file = location[1]; line = +location[2]; }
        if (lines[j].trim() && !/^[ \t]+# /.test(lines[j])) message.push(lines[j].trim());
      }
      failures.push({
        file, line, title: header[1], subject: header[1], severity: "error",
        message: message.join("\n").replace(/^Failure\/Error:[ \t]*/, ""),
      });
    }
    if (!failures.length) return null;
    // rspec writes "1 failure" and "2 failures"; rebuilding the sentence from the
    // numbers lost that and always said "failures"
    const summaryMatch = s.match(/\d+ examples?, \d+ failures?(?:, \d+ pending)?/);
    return {
      tool: "rspec",
      summary: summaryMatch ? summaryMatch[0] : `${failures.length} failures`,
      failures,
    };
  },
};
