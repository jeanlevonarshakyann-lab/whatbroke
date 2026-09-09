const LOCATION_RE = /^[^\S\n]+#[^\S\n]+(.+):(\d+):in\b/;
// A spec file that raises while being loaded never becomes a numbered example, so it is
// reported as prose above the tally instead - and the tally then says "0 examples, 0
// failures, 1 error occurred outside of examples", which is not a failure count the
// numbered form would ever produce.
const LOAD_ERROR_RE = /^An error occurred while loading (.+?)\.$/;

export default {
  name: "rspec",
  category: "test",
  commands: ["rspec", "bundle"],
  detect: (s) =>
    (/^[^\S\n]+\d+\) /m.test(s) &&
      (/Finished in .+ seconds?/m.test(s) || /^\d+ examples?, \d+ failures?/m.test(s))) ||
    (LOAD_ERROR_RE.test(s.split("\n").find((l) => LOAD_ERROR_RE.test(l)) ?? "") &&
      /^\d+ examples?, \d+ failures?/m.test(s)),

  extract(s) {
    const lines = s.split("\n");
    const failures = [];
    for (let i = 0; i < lines.length; i++) {
      const load = lines[i].match(LOAD_ERROR_RE);
      if (load) {
        let file = load[1], line, message = [];
        for (let j = i + 1; j < lines.length && !/^No examples found\.|^Finished in /.test(lines[j]); j++) {
          const at = lines[j].match(/^#[^\S\n]+(.+?):(\d+):in\b/) ?? lines[j].match(LOCATION_RE);
          if (at) { file = at[1]; line = +at[2]; continue; }
          if (lines[j].trim()) message.push(lines[j].trim());
        }
        failures.push({
          file, line, title: "load error", label: "load error", severity: "error",
          message: message.join("\n").replace(/^Failure\/Error:[^\S\n]*/, ""),
        });
        continue;
      }
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
    // "0 examples, 0 failures" is what rspec's tally starts with when a spec file failed
    // to load, and stopping there turns a real failure into a headline that reads like
    // success. The clause that says what happened comes after it.
    const summaryMatch = s.match(/\d+ examples?, \d+ failures?(?:, \d+ pending)?(?:, \d+ errors? occurred outside of examples)?/);
    return {
      tool: "rspec",
      summary: summaryMatch ? summaryMatch[0] : `${failures.length} failures`,
      failures,
    };
  },
};
