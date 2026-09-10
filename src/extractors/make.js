// make's own diagnostics - a malformed makefile, a target with no rule, a recipe whose
// command is not installed. What fails UNDER make is usually a compiler, and that
// already has a parser; make's "*** [Makefile:2: all] Error 1" only restates that
// something below it exited non-zero.
//
// So this parser reads make's causes and never its consequences. The dividing line is
// make's own: it ends a line with "Stop." when make itself is refusing to continue, and
// with "Error N" when it is relaying somebody else's exit status. Requiring "Stop." is
// what keeps a nested build - where "make[1]: *** [all] Error 1" and "make: *** [all]
// Error 2" are one compiler error propagating up two levels - from being read as two
// failures on top of the one the compiler already reported.
//
// Everything matched here is anchored on a prefix make writes about itself, so the
// parser never reads a line make did not produce. There is no surrounding-context scan.
const QUOTED = /[`'"]([^`'"]+)['"]/;
// `Makefile:2: *** missing separator.  Stop.` - a makefile make could not parse.
const AT_LINE = /^([^\s:]+):(\d+):[^\S\n]+\*\*\*[^\S\n]+(.+?)[^\S\n]*Stop\.[^\S\n]*$/m;
// `make: *** No rule to make target 'missing.o', needed by 'all'.  Stop.`
const SELF = /^make(?:\[\d+\])?:[^\S\n]+\*\*\*[^\S\n]+(.+?)[^\S\n]*Stop\.[^\S\n]*$/m;
// `make: this-command-does-not-exist: No such file or directory` - the recipe's command.
//
// The middle is a bare name: no spaces, no colons. That is what separates these two
// lines from a compiler's, because gcc writes a missing header the same way once its
// column is turned off - `inc.c:1: fatal error: nope.h: No such file or directory` - and
// with `(.+?)` there make claimed it, out-ranked clang, and reported a C compile error
// as a make failure whose subject was "fatal error: nope.h". A severity word and its
// colon cannot fit through a filename-shaped hole.
const NAME = "([^\\s:]+)";
const MISSING = new RegExp(`^make(?:\\[\\d+\\])?:[^\\S\\n]+${NAME}:[^\\S\\n]+(No such file or directory|Permission denied|Command not found)[^\\S\\n]*$`, "m");
// `Makefile:1: nope.mk: No such file or directory` - an include that is not there.
const MISSING_AT_LINE = new RegExp(`^([^\\s:]+):(\\d+):[^\\S\\n]+${NAME}:[^\\S\\n]+(No such file or directory|Permission denied)[^\\S\\n]*$`, "m");

export default {
  name: "make",
  category: "build",
  commands: ["make", "gmake", "bmake"],

  // "***" alone is not enough to claim a log: make writes it on the exit line too, and
  // that line belongs to whatever actually failed. Claim only what this parser can read.
  detect: (s) => AT_LINE.test(s) || SELF.test(s) || MISSING.test(s) || MISSING_AT_LINE.test(s),

  extract(s) {
    const failures = [];
    // make reports a missing include twice: once against the line that included it, then
    // again as a target it cannot build. The first knows where the problem is written.
    const named = new Set();
    const push = (f) => {
      if (f.subject && named.has(f.subject)) return;
      if (f.subject) named.add(f.subject);
      failures.push({ severity: "error", ...f });
    };
    for (const line of s.split("\n")) {
      let m;
      if ((m = line.match(MISSING_AT_LINE))) {
        push({ file: m[1], line: +m[2], title: m[3], subject: m[3], message: `${m[3]}: ${m[4]}` });
        continue;
      }
      if ((m = line.match(AT_LINE))) {
        push({ file: m[1], line: +m[2], title: "makefile error", label: "makefile error", message: m[3].trim() });
        continue;
      }
      if ((m = line.match(SELF))) {
        const text = m[1].trim();
        const q = text.match(QUOTED);
        push(q
          ? { title: q[1], subject: q[1], message: text }
          : { title: "make error", label: "make error", message: text });
        continue;
      }
      if ((m = line.match(MISSING))) {
        push({ title: m[1], subject: m[1], message: `${m[1]}: ${m[2]}` });
      }
    }
    if (!failures.length) return null;
    const n = failures.length;
    return { tool: "make", summary: `${n} error${n > 1 ? "s" : ""}`, failures };
  },
};
