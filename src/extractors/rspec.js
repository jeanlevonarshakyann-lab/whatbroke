const LOCATION_RE = /^[^\S\n]+#[^\S\n]+(.+):(\d+):in\b/;

export default {
  name: "rspec",
  category: "test",
  commands: ["rspec", "bundle"],
  detect: (s) =>
    /^[^\S\n]+\d+\) /m.test(s) &&
    (/Finished in .+ seconds?/m.test(s) || /^\d+ examples?, \d+ failures?/m.test(s)),

  extract(s) {
    const lines = s.split("\n");
    const failures = [];
    for (let i = 0; i < lines.length; i++) {
      const header = lines[i].match(/^[^\S\n]+\d+\)[^\S\n]+(.+)$/);
      if (!header) continue;
      let message = [];
      let file;
      let line;
      for (let j = i + 1; j < lines.length &&
        !/^[^\S\n]+\d+\)[^\S\n]+/.test(lines[j]) &&
        !/^Finished in /.test(lines[j]) &&
        !/^Top \d+ slowest/.test(lines[j]) &&
        !/^Failed examples:/.test(lines[j]); j++) {
        const location = lines[j].match(LOCATION_RE);
        if (location) { file = location[1]; line = +location[2]; }
        if (lines[j].trim() && !/^[^\S\n]+# /.test(lines[j])) message.push(lines[j].trim());
      }
      failures.push({
        file, line, title: header[1], subject: header[1], severity: "error",
        message: message.join("\n").replace(/^Failure\/Error:[^\S\n]*/, ""),
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
