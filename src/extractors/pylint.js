// pylint heads each module it checked and then lists its findings, with the symbolic
// name of the check in parentheses at the end:
//
//   ************* Module lint_me
//   lint_me.py:1:0: C0114: Missing module docstring (missing-module-docstring)
//   lint_me.py:3:4: W0612: Unused variable 'unused' (unused-variable)
//
//   Your code has been rated at 2.00/10
//
// The symbolic name is what you would put in a disable comment, and it is what pylint's
// own documentation is indexed by - more useful than C0114 on its own, so both are kept:
// the code identifies, the name explains.
const FINDING_RE = /^(\S+?):(\d+):(\d+):[^\S\n]+([CRWEF]\d{4}):[^\S\n]+(.+?)(?:[^\S\n]+\(([\w-]+)\))?[^\S\n]*$/;
const MODULE_RE = /^\*{3,}[^\S\n]+Module[^\S\n]+\S+/m;
const RATING_RE = /^Your code has been rated at/m;
// C and R are convention and refactor suggestions; W is a warning. E and F stop the run.
const STOPS_THE_RUN = /^[EF]/;

export default {
  name: "pylint",
  category: "lint",
  commands: ["pylint"],

  // flake8 writes the same location shape without a colon after its code, so the colon
  // is what tells them apart - and pylint's module banner confirms it.
  detect: (s) => MODULE_RE.test(s) || RATING_RE.test(s),

  extract(s) {
    // Collect first, decide after. Only E and F stop a run; C, R and W are convention,
    // refactor and warning. But pylint exits non-zero on those alone, so a run that
    // found nothing but conventions still failed and still has to say why - reporting
    // none of them would be reporting nothing.
    const all = [];
    for (const line of s.split("\n")) {
      const m = line.match(FINDING_RE);
      if (!m) continue;
      all.push({
        file: m[1], line: +m[2], col: +m[3],
        title: m[6] ?? m[4], code: m[4], severity: "error",
        message: m[5].trim(),
        stops: STOPS_THE_RUN.test(m[4]),
      });
    }
    const stopping = all.filter((f) => f.stops);
    // A real error alongside a missing docstring buries the error, so when there is one
    // the advisories step aside and are counted instead.
    const chosen = stopping.length ? stopping : all;
    const advisory = all.length - chosen.length;
    const failures = chosen.map(({ stops, ...f }) => f);

    if (!failures.length) return null;
    const n = failures.length;
    return {
      tool: "pylint",
      summary: `${n} problem${n === 1 ? "" : "s"}` +
        (advisory ? `, ${advisory} advisory hidden` : ""),
      failures,
    };
  },
};
