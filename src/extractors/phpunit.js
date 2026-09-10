const LOCATION_RE = /^[^\S\n]*(.+?):(\d+)$/;
// PHPUnit separates an assertion that did not hold ("failure") from an exception that
// escaped ("error") and heads each block differently. Reading only the first meant an
// uncaught exception - at least as common as a failed assertion - fell through.
const TALLY_RE = /There (?:was|were) \d+ (?:failure|error)/;
// A file that throws while being loaded never becomes a numbered result at all.
const INTERNAL_RE = /^An error occurred inside PHPUnit\.$/m;

export default {
  name: "phpunit",
  category: "test",
  commands: ["phpunit"],
  detect: (s) =>
    (TALLY_RE.test(s) && /^\d+\)[^\S\n]+[\w\\]+::\w+/m.test(s)) ||
    (INTERNAL_RE.test(s) && /^Location:[^\S\n]+\S+:\d+$/m.test(s)),

  extract(s) {
    const lines = s.split("\n");
    const failures = [];

    if (INTERNAL_RE.test(s)) {
      const message = s.match(/^Message:[^\S\n]+(.+)$/m);
      const at = s.match(/^Location:[^\S\n]+(.+?):(\d+)$/m);
      if (message || at) {
        return {
          tool: "phpunit",
          summary: "error inside PHPUnit",
          failures: [{
            file: at?.[1], line: at ? +at[2] : undefined,
            title: "load error", label: "load error", severity: "error",
            message: message?.[1] ?? "An error occurred inside PHPUnit.",
          }],
        };
      }
    }
    // PHPUnit's numbered blocks live under "There were N failures:" and nowhere else.
    // "N) name" belongs to jasmine, mocha, rspec and Playwright too, and jasmine writes
    // its own at column zero exactly as PHPUnit does - so scanning the whole log claimed
    // jasmine's failures as PHPUnit's whenever both were in it.
    const announced = lines.findIndex((l) => TALLY_RE.test(l));
    // ...and they end where PHPUnit's run does. Without that bound a log with PHPUnit
    // first read whatever numbered blocks came after it as more of its own. The inner
    // loop already stopped there; the outer one did not.
    const END_RE = /^[^\S\n]*(?:Tests:|OK\b|FAILURES!|ERRORS!|WARNINGS!)/;
    for (let i = announced + 1; i < lines.length && !END_RE.test(lines[i]); i++) {
      const header = lines[i].match(/^\d+\)[^\S\n]+(.+)$/);
      if (!header) continue;
      const message = [];
      let file;
      let line;
      for (let j = i + 1; j < lines.length &&
        !/^\d+\)[^\S\n]+/.test(lines[j]) &&
        !/^[^\S\n]*(?:Tests:|Time:|OK\b|FAILURES!|ERRORS!|WARNINGS!)/.test(lines[j]); j++) {
        const location = lines[j].match(LOCATION_RE);
        if (location && /\.[a-z]+$/i.test(location[1])) {
          file = location[1];
          line = +location[2];
        } else if (lines[j].trim()) {
          message.push(lines[j].trim());
        }
      }
      failures.push({ file, line, title: header[1], subject: header[1], severity: "error", message: message.join("\n") });
    }
    if (!failures.length) return null;
    // PHPUnit's tally names failures and errors separately, and reporting only the
    // failures said "0 failures" over a run that errored.
    const tally = s.match(/^Tests:[^\S\n]+(.+?)\.?$/m);
    const counted = [];
    for (const kind of ["Failures", "Errors"]) {
      const m = tally?.[1].match(new RegExp(`${kind}:[^\\S\\n]*(\\d+)`));
      const n = Number(m?.[1] ?? 0);
      if (n) counted.push(`${n} ${kind.toLowerCase().replace(/s$/, "")}${n > 1 ? "s" : ""}`);
    }
    return {
      tool: "phpunit",
      summary: counted.length ? counted.join(", ") : `${failures.length} failures`,
      failures,
    };
  },
};
