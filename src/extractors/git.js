// git is the most-run command that can fail, and what it prints is mostly advice.
//
// A merge conflict says "Automatic merge failed; fix conflicts and then commit the
// result", which is the mechanism - the answer is the two CONFLICT lines above it
// naming the files. A rejected push says "failed to push some refs", then five lines of
// hint: explaining fast-forwards - the answer is the one ! [rejected] line. Both were
// coming back as a labelled guess pointing at the wrong line, or as nothing at all.

const CONFLICT = /^CONFLICT \(([^)]+)\): (?:Merge conflict in|.*? in) (.+)$/;
const REJECTED = /^[^\S\n]*!\s+\[([^\]]+)\][^\S\n]+(\S+)[^\S\n]+->[^\S\n]+(\S+)(?:[^\S\n]+\((.+)\))?$/;
const OVERWRITE = /^error: Your local changes to the following files would be overwritten by (\w+):$/;
const DIAGNOSTIC = /^(fatal|error): (.+)$/;

// Everything git prints to be helpful rather than to say what went wrong.
const ADVICE = [
  /^hint: /, /^Please commit your changes or stash them/, /^Aborting$/,
  /^Use '--' to separate paths from revisions/, /^'git <command>/,
  /^Auto-merging /, /^Updating [0-9a-f]+\.\.[0-9a-f]+$/, /^To /,
  /^Either specify the URL from the command-line/, /^[^\S\n]*git remote add /,
  /^Automatic merge failed; fix conflicts/,
];
// "failed to push some refs" restates a rejection the ! line already explained.
const RESTATES = /^failed to push some refs/;

const GIT_MARKERS = /(not a git repository|CONFLICT \(|failed to push some refs|would be overwritten by|did not match any file\(s\) known to git|not something we can merge|No configured push destination|unknown revision or path not in the working tree|Automatic merge failed|unmerged files)/;

export default {
  name: "git",
  category: "vcs",
  commands: ["git"],

  // `fatal:` and `error:` belong to half the tools in existence, so one of git's own
  // phrases has to be present too.
  detect: (s) =>
    (/^(?:fatal|error): /m.test(s) || /^CONFLICT \(/m.test(s) || /^[^\S\n]*!\s+\[rejected\]/m.test(s)) &&
    GIT_MARKERS.test(s),

  extract(s) {
    const lines = s.split("\n");
    const failures = [];
    let conflicts = 0;
    let rejected = false;
    // `error:` and `fatal:` at line start belong to half the tools in existence, and in
    // a log holding more than one they are as likely to be somebody else's - cargo's
    // "error: could not compile ... due to 3 previous errors" is a tally cargo itself
    // suppresses. When git has said something structural - a conflict, a rejected push,
    // files that would be overwritten - that IS the failure, and a loose line elsewhere
    // in the log is not a second one.
    const bare = [];

    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (ADVICE.some((re) => re.test(l))) continue;

      const c = l.match(CONFLICT);
      if (c) {
        conflicts++;
        failures.push({ file: c[2], title: "merge conflict", label: "merge conflict", severity: "error", message: `${c[1]} conflict` });
        continue;
      }

      const r = l.match(REJECTED);
      if (r) {
        rejected = true;
        failures.push({ title: r[1], label: r[1], severity: "error", subject: undefined,
          message: `${r[2]} -> ${r[3]}${r[4] ? ` (${r[4]})` : ""}` });
        continue;
      }

      const o = l.match(OVERWRITE);
      if (o) {
        // the files follow, one per line, indented
        for (let j = i + 1; j < lines.length && /^[^\S\n]+\S/.test(lines[j]); j++) {
          failures.push({ file: lines[j].trim(), title: "local changes", label: "local changes", severity: "error",
            message: `would be overwritten by ${o[1]}` });
        }
        continue;
      }

      const d = l.match(DIAGNOSTIC);
      if (d && !(rejected && RESTATES.test(d[2]))) bare.push({ title: d[1], label: d[1], severity: "error", message: d[2] });
    }

    if (!failures.length) failures.push(...bare);
    if (!failures.length) return null;
    // A summary that just repeats the only failure's message says it twice. Count the
    // conflicted files, which is the one case where a tally adds something.
    const summary = conflicts ? `${conflicts} conflicted file${conflicts > 1 ? "s" : ""}` : undefined;
    return { tool: "git", summary, failures };
  },
};
