// PHP says everything twice. A fatal goes to the error log with a "PHP " prefix and to
// stdout without one, so a single failure arrives as two identical blocks:
//
//   PHP Fatal error:  Uncaught Error: Call to a member function call() on null in /a/p.php:4
//   Stack trace:
//   #0 /a/p.php(8): Gateway->charge(1050)
//   #1 {main}
//     thrown in /a/p.php on line 4
//
//   Fatal error: Uncaught Error: ... (the same again)
//
// The two copies produce identical failures, so the pipeline's own de-duplication
// collapses them - which is why nothing here counts blocks.
const UNCAUGHT_RE = /^(?:PHP[^\S\n]+)?Fatal error:[^\S\n]+Uncaught[^\S\n]+([\w\\]+):[^\S\n]+(.+?)[^\S\n]+in[^\S\n]+(.+?):(\d+)$/;
// Not every fatal is a thrown exception: a call to an undefined function, an abstract
// class instantiated. Those name the file the long way round.
const FATAL_RE = /^(?:PHP[^\S\n]+)?Fatal error:[^\S\n]+(?!Uncaught[^\S\n])(.+?)[^\S\n]+in[^\S\n]+(.+?)[^\S\n]+on line[^\S\n]+(\d+)$/;
const PARSE_RE = /^(?:PHP[^\S\n]+)?Parse error:[^\S\n]+(.+?)[^\S\n]+in[^\S\n]+(.+?)[^\S\n]+on line[^\S\n]+(\d+)$/;
// The include path is longer than the diagnosis and never varies, while the file it
// could not find is the answer. Same shape of noise as perl's @INC list.
const INCLUDE_PATH = /[^\S\n]*\(include_path='[^']*'\)/;
const WARNING_RE = /^(?:PHP[^\S\n]+)?(?:Warning|Notice|Deprecated):[^\S\n]/;
const FRAME_RE = /^#(\d+)[^\S\n]+(?:(.+?)\((\d+)\):[^\S\n]+(.+)|\{main\})$/;
// PHP repeats the location under the stack. The line above already said it.
const THROWN_RE = /^[^\S\n]*thrown in[^\S\n]+.+[^\S\n]+on line[^\S\n]+\d+$/;

export default {
  name: "php",
  category: "runtime",
  commands: ["php", "php-cgi"],

  detect: (s) => {
    const lines = s.split("\n");
    return lines.some((l) => UNCAUGHT_RE.test(l) || FATAL_RE.test(l) || PARSE_RE.test(l));
  },

  extract(s) {
    const lines = s.split("\n");
    const failures = [];
    // Warnings arrive doubled like everything else, so counting lines said "2 warnings"
    // for one. The two copies differ only by the "PHP " prefix the error log adds.
    const warned = new Set();

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (THROWN_RE.test(line)) continue;
      // The error log writes "Warning:  x" with two spaces, stdout writes "Warning: x"
      // with one, so the runs have to be flattened before the two copies compare equal.
      if (WARNING_RE.test(line)) { warned.add(line.replace(/^PHP[^\S\n]+/, "").replace(/\s+/g, " ").trim()); continue; }

      const uncaught = line.match(UNCAUGHT_RE);
      const fatal = !uncaught && line.match(FATAL_RE);
      const parse = !uncaught && !fatal && line.match(PARSE_RE);
      if (!uncaught && !fatal && !parse) continue;

      let trace;
      if (uncaught || fatal) {
        // "Stack trace:" then "#0 /a/p.php(8): Gateway->charge(1050)", innermost first.
        // "#N {main}" is the entry point and carries nothing.
        const frames = [];
        for (let j = i + 1; j < lines.length && j <= i + 32; j++) {
          if (/^Stack trace:$/.test(lines[j])) continue;
          const f = lines[j].match(FRAME_RE);
          if (!f) { if (frames.length) break; else continue; }
          if (f[2]) frames.push(`${f[4]} (${f[2]}:${f[3]})`);
        }
        if (frames.length) trace = frames.slice(0, 4);
      }

      failures.push(uncaught
        ? { file: uncaught[3], line: +uncaught[4], title: uncaught[1], code: uncaught[1],
            severity: "error", message: uncaught[2].replace(INCLUDE_PATH, ""), trace }
        : fatal
          ? { file: fatal[2], line: +fatal[3], title: "fatal error", label: "fatal error",
              severity: "error", message: fatal[1], trace }
          : { file: parse[2], line: +parse[3], title: "parse error", label: "parse error",
              severity: "error", message: parse[1] });
    }

    if (!failures.length) return null;
    // The count is of distinct failures, which is not known until the pipeline has
    // collapsed PHP's doubled output - so the headline says what broke, not how many.
    // The warnings PHP printed first are context, not the headline: "2 warnings before
    // it" over a fatal error reads as though nothing broke, which is the one thing a
    // headline must never do. The count of what failed leads, and the warnings follow it.
    //
    // `failures` is still doubled here - the pipeline collapses PHP's two copies after
    // this returns - so the count is of distinct locations rather than of lines.
    const warnings = warned.size;
    const distinct = new Set(failures.map((f) => `${f.file}:${f.line}:${f.message}`)).size;
    const summary = distinct > 1 || warnings
      ? `${distinct} error${distinct === 1 ? "" : "s"}${warnings ? `, ${warnings} warning${warnings === 1 ? "" : "s"} first` : ""}`
      : undefined;
    return { tool: "php", summary, failures };
  },
};
