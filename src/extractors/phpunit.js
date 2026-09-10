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

    // PHPUnit erroring inside itself used to end the read. One run that does that has no
    // test results to report, so there was nothing else to find - but a log holding more
    // than one run does, and returning early dropped the other run's failures silently.
    const internal = [];
    if (INTERNAL_RE.test(s)) {
      const message = s.match(/^Message:[^\S\n]+(.+)$/m);
      const at = s.match(/^Location:[^\S\n]+(.+?):(\d+)$/m);
      if (message || at) {
        internal.push({
          file: at?.[1], line: at ? +at[2] : undefined,
          title: "load error", label: "load error", severity: "error",
          message: message?.[1] ?? "An error occurred inside PHPUnit.",
        });
      }
    }
    // PHPUnit's numbered blocks live under "There were N failures:" and nowhere else.
    // "N) name" belongs to jasmine, mocha, rspec and Playwright too, and jasmine writes
    // its own at column zero exactly as PHPUnit does - so scanning the whole log claimed
    // jasmine's failures as PHPUnit's whenever both were in it.
    // One log can hold more than one PHPUnit run - a testsuite at a time, or a package
    // at a time across a monorepo - and each announces its own blocks. Reading only the
    // first announcement stopped at that run's section and dropped the rest.
    const announcements = lines.flatMap((l, i) => (TALLY_RE.test(l) ? [i] : []));
    // ...and they end where PHPUnit's run does. Without that bound a log with PHPUnit
    // first read whatever numbered blocks came after it as more of its own. The inner
    // loop already stopped there; the outer one did not.
    const END_RE = /^[^\S\n]*(?:Tests:|OK\b|FAILURES!|ERRORS!|WARNINGS!)/;
    // No announcement, no blocks. This was true before only by accident: a log without
    // the tally was a log that had errored inside PHPUnit, and that returned early
    // before ever reaching here. Letting it reach here started the scan at line 0 and
    // read jasmine's numbered blocks as PHPUnit's - 5 failures where the two logs hold
    // 3 - which is the same claim the bound above exists to prevent.
    for (const announced of announcements) {
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
    }
    if (!failures.length && !internal.length) return null;
    // PHPUnit's tally names failures and errors separately, and reporting only the
    // failures said "0 failures" over a run that errored.
    const tally = s.match(/^Tests:[^\S\n]+(.+?)\.?$/m);
    const counted = [];
    for (const kind of ["Failures", "Errors"]) {
      const m = tally?.[1].match(new RegExp(`${kind}:[^\\S\\n]*(\\d+)`));
      const n = Number(m?.[1] ?? 0);
      if (n) counted.push(`${n} ${kind.toLowerCase().replace(/s$/, "")}${n > 1 ? "s" : ""}`);
    }
    if (internal.length) {
      // The internal error is why PHPUnit stopped, so it leads; whatever else the log
      // holds follows it rather than being dropped.
      const rest = counted.length ? counted.join(", ") : failures.length ? `${failures.length} failures` : "";
      return {
        tool: "phpunit",
        summary: rest ? `error inside PHPUnit — ${rest} elsewhere` : "error inside PHPUnit",
        failures: [...internal, ...failures],
      };
    }
    return {
      tool: "phpunit",
      summary: counted.length ? counted.join(", ") : `${failures.length} failures`,
      failures,
    };
  },
};
