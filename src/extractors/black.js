// black --check names the files it would rewrite and nothing else:
//
//   would reformat ugly.py
//   Oh no! 💥 💔 💥
//   1 file would be reformatted.
//
// It exits non-zero, so a job fails on it; the parser exists so that failure says which
// files rather than nothing at all. A file black cannot parse is reported differently,
// with the reason and a location.
const REFORMAT_RE = /^would reformat[^\S\n]+(\S.*?)[^\S\n]*$/;
const TALLY_RE = /^\d+ files? would be reformatted/m;
// "error: cannot format bad.py: Cannot parse: 2:9: def f( :" - the parse failure form.
const CANNOT_RE = /^error:[^\S\n]*cannot format[^\S\n]+(\S+?):[^\S\n]*(.+?)[^\S\n]*$/;
// "Cannot parse: 1:7" - and sometimes "Cannot parse: 1:7: def f( :" with the source
// after it. The trailing colon is not always there.
const AT_RE = /Cannot parse:[^\S\n]*(\d+):(\d+):?[^\S\n]*(.*)$/;

export default {
  name: "black",
  category: "lint",
  commands: ["black"],

  detect: (s) => TALLY_RE.test(s) || s.split("\n").some((l) => REFORMAT_RE.test(l) || CANNOT_RE.test(l)),

  extract(s) {
    const failures = [];
    for (const line of s.split("\n")) {
      const bad = line.match(CANNOT_RE);
      if (bad) {
        const at = bad[2].match(AT_RE);
        failures.push({
          file: bad[1],
          line: at ? +at[1] : undefined, col: at ? +at[2] : undefined,
          title: "unparsable", label: "unparsable", severity: "error",
          message: bad[2].trim(), stmt: at?.[3]?.trim() || undefined,
        });
        continue;
      }
      const m = line.match(REFORMAT_RE);
      if (m) {
        failures.push({
          file: m[1], title: "not formatted", label: "not formatted", severity: "error",
          message: "this file is not formatted as black would write it",
        });
      }
    }
    if (!failures.length) return null;
    const n = failures.length;
    // "would be reformatted" says nothing went wrong, and the run exited non-zero.
    return {
      tool: "black",
      summary: `${n} file${n === 1 ? "" : "s"} failed the format check`,
      failures,
    };
  },
};
