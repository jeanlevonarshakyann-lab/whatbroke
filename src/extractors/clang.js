// The column is optional. gcc drops it under -fno-show-column, and older gcc never
// printed one at all - which left `inc.c:1: fatal error: nope.h: No such file or
// directory` read by no parser in the tool.
//
// Without the column, though, `file:line: error: message` is the most common diagnostic
// shape there is: it is also javac's, gradle's and mypy's. Allowing it on shape alone
// made clang claim 100 of the corpus's ordered pairs - Java and Python diagnostics
// reported as C compile errors. Requiring the log to mention a compiler somewhere is not
// a bound either, because in a mixed log clang's own output satisfies that and the Java
// lines are read anyway. The bound has to be on the line: a C compiler compiles C-family
// sources, so when there is no column to identify the shape, the filename must.
const DIAGNOSTIC_RE = /^(.+?):(\d+):(?:(\d+):)?[^\S\n]+(error|fatal error|warning|note):[^\S\n]+(.+)$/;
const C_FAMILY = /\.(?:c|cc|cp|cxx|cpp|c\+\+|m|mm|h|hh|hp|hpp|hxx|h\+\+|tcc|i|ii|s|sx)$/i;
const CODE_RE = /[^\S\n]+\[(-W[\w-]+)\]$/;
// The driver speaks for itself when there is no source to point at: a missing input, an
// unknown flag, a failed link. These carry no file:line, so the pattern above never sees
// them and a `make` run that could not even start compiling fell through to a guess.
const DRIVER_RE = /^(clang(?:\+\+)?|gcc|g\+\+|cc|ld|cc1(?:plus)?):[^\S\n]+(error|fatal error):[^\S\n]+(.+)$/;

export default {
  name: "clang",
  category: "compile",
  commands: ["clang", "clang++", "gcc", "g++", "cc", "make"],
  detect: (s) =>
    (/^\S.+:\d+(?::\d+)?:[^\S\n]+(?:error|fatal error|warning|note):[^\S\n]+/m.test(s) &&
     /(?:clang|gcc|g\+\+|cc1|ld:|[\w.-]+\.(?:c|cc|cpp|cxx|h|hpp|m|mm):)/i.test(s)) ||
    // A driver error names the driver, which is as specific as the pattern above.
    DRIVER_RE.test(s.split("\n").find((l) => DRIVER_RE.test(l)) ?? ""),

  extract(s) {
    const failures = [];
    let warnings = 0;
    for (const line of s.split("\n")) {
      const driver = line.match(DRIVER_RE);
      if (driver) {
        // "no input files" only restates the failure above it; the first one is the cause.
        if (!/^no input files$/.test(driver[3])) {
          failures.push({ title: driver[2], label: driver[2], severity: "error", message: driver[3] });
        }
        continue;
      }
      const match = line.match(DIAGNOSTIC_RE);
      if (!match || match[4] === "note") continue;
      if (!match[3] && !C_FAMILY.test(match[1])) continue;
      const code = match[5].match(CODE_RE);
      const message = code ? match[5].replace(CODE_RE, "") : match[5];
      if (match[4] === "warning") { warnings++; continue; }
      failures.push({
        file: match[1], line: +match[2], ...(match[3] ? { col: +match[3] } : {}),
        title: code?.[1] ?? match[4], code: code?.[1], label: code ? undefined : match[4], severity: match[4], message,
      });
    }
    if (!failures.length) return null;
    // clang ends each translation unit with its own count, and every clean log in the
    // corpus agrees with it exactly - 14 for 14, 3 for 3. It stops agreeing when the log
    // has been damaged, and the commonest way that happens is `make -j`: two compilers
    // writing into one pipe interleave mid-line, and
    //
    //   b.c:1    1 | :21: error: use of undeclared identifier 'alsonope'
    //
    // is b.c's diagnostic with a fragment of a.c's source frame driven through the
    // middle of it. That line cannot be recovered without guessing which bytes are
    // foreign, and this does not try. What it will not do any more is report "1 error"
    // over a log where clang said there were two - the count is the one part of the
    // wreckage that survived intact, and saying nothing was the real failure here.
    const declared = [...s.matchAll(/^(\d+) errors? generated\.$/gm)]
      .reduce((n, m) => n + Number(m[1]), 0);
    const n = failures.length;
    const missed = declared > n ? declared : 0;
    return {
      tool: "clang",
      summary: (missed ? `${n} of the ${missed} errors clang reported` : `${n} error${n > 1 ? "s" : ""}`) +
        (warnings ? ` — ${warnings} warning${warnings > 1 ? "s" : ""} hidden` : ""),
      failures,
    };
  },
};
