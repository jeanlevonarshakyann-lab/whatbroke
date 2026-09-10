// RuboCop is what a Ruby CI job usually fails on, and its output had no parser: the
// fallback scraped the lines but dropped the column, the cop name and the severity, and
// reported a style convention as an error.
//
//   app.rb:2:3: W: [Correctable] Lint/UselessAssignment: Useless assignment - unused.
//     unused = 42
//     ^^^^^^
//
// The severity is a single letter and the cop is Category/Name, and requiring both is
// what keeps this off every other tool's `file:line:col:` line. `[Correctable]` is
// rubocop telling you `-a` would fix it, not part of what is wrong.
const OFFENSE = /^(.+?):(\d+):(\d+):[^\S\n]+([CWEFR]):[^\S\n]+(?:\[[^\]]*\][^\S\n]+)?([A-Z]\w*\/[A-Z]\w*):[^\S\n]+(.+?)[^\S\n]*$/;
// The carets rubocop draws under the offending span. They are what says the line above
// them is the source and not more prose - the syntax-error case puts a note about the
// parser version there instead, and quoting that as the offending line would be wrong.
const CARETS = /^[^\S\n]*\^+[^\S\n]*$/;
const TALLY = /^\d+ files? inspected, (\d+) offenses? detected/m;

export default {
  name: "rubocop",
  category: "lint",
  commands: ["rubocop"],

  detect: (s) => OFFENSE.test(s.split("\n").find((l) => OFFENSE.test(l)) ?? ""),

  extract(s) {
    const lines = s.split("\n");
    const found = [];
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(OFFENSE);
      if (!m) continue;
      const stmt = CARETS.test(lines[i + 2] ?? "") ? lines[i + 1].trim() : undefined;
      found.push({
        file: m[1], line: +m[2], col: +m[3], letter: m[4],
        title: m[5], code: m[5], message: m[6], ...(stmt ? { stmt } : {}),
      });
    }
    if (!found.length) return null;
    // rubocop's ladder is F, E, W, C, R. Only the first two are a failure in their own
    // right; the rest are house style, and pylint - the same shape in the other
    // ecosystem - sets those aside behind a real error the same way. rubocop exits
    // non-zero on any offence, so when there is no error the conventions are the reason
    // and saying nothing would be worse than saying they are only conventions.
    const errors = found.filter((f) => /[EF]/.test(f.letter));
    const shown = errors.length ? errors : found;
    const hidden = found.length - shown.length;
    const n = shown.length;
    const declared = s.match(TALLY);
    return {
      tool: "rubocop",
      summary: `${n} problem${n === 1 ? "" : "s"}` +
        (hidden ? `, ${hidden} advisory hidden` : "") +
        (!errors.length && declared && +declared[1] !== n ? ` of ${declared[1]} offences` : ""),
      failures: shown.map(({ letter, ...f }) => ({ ...f, severity: "error" })),
    };
  },
};
