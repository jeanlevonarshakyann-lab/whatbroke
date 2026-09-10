// golangci-lint is what a Go CI job usually fails on. Its findings look almost exactly
// like `go build`'s, and go's parser was claiming them - so a lint run came back as
// "6 compile errors" from a tool called `go build`, with the linter's name left sitting
// inside the message where it could not be grouped on.
//
//   main.go:10:15: Error return value of `f.Close` is not checked (errcheck)
//   	defer f.Close()
//   	             ^
//
// What separates the two is the linter's name in brackets at the end of the line. go's
// own diagnostics put their brackets in the middle - "cannot use 42 (untyped int
// constant) as string value" - and never at the end, and go prints no source line or
// caret under them at all.
//
// The file has to be a .go file, which is the other half of the bound and not a detail:
// a trailing "(name)" is also how pylint ends every line - "Undefined variable 'x'
// (undefined-variable)" - and how yamllint's parsable format ends its own. Without it
// this claimed both of them, and 42 ordered pairs in test/mixed.js changed their
// failures. golangci-lint lints Go, so the extension is something the tool itself
// guarantees rather than a guess about shape.
const ISSUE = /^(?:\.[\\/])?(.+?\.go):(\d+):(\d+):[^\S\n]+(.+?)[^\S\n]+\(([\w-]+)\)[^\S\n]*$/;
const CARETS = /^[^\S\n]*\^[^\S\n]*$/;
// golangci-lint ends with its own count and a breakdown by linter.
const TALLY = /^(\d+) issues?:[^\S\n]*$/m;

export default {
  name: "golangci-lint",
  category: "lint",
  commands: ["golangci-lint"],

  // A trailing "(name)" alone is thin, so it has to be corroborated by something else
  // golangci-lint writes and go does not: its tally, or the caret it draws under the
  // source line. Either is enough; both are absent from every go build log.
  detect(s) {
    const lines = s.split("\n");
    if (!lines.some((l) => ISSUE.test(l))) return false;
    return TALLY.test(s) || lines.some((l, i) => ISSUE.test(l) && CARETS.test(lines[i + 2] ?? ""));
  },

  extract(s) {
    const lines = s.split("\n");
    const failures = [];
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(ISSUE);
      if (!m) continue;
      const stmt = CARETS.test(lines[i + 2] ?? "") ? lines[i + 1].trim() : undefined;
      failures.push({
        file: m[1], line: +m[2], col: +m[3],
        // The linter that raised it is what you would disable, and what groups a run of
        // findings into one thing to fix.
        title: m[5], code: m[5], severity: "error", message: m[4],
        ...(stmt ? { stmt } : {}),
      });
    }
    if (!failures.length) return null;
    const declared = s.match(TALLY);
    const n = failures.length;
    return {
      tool: "golangci-lint",
      summary: `${n} problem${n === 1 ? "" : "s"}` +
        (declared && +declared[1] !== n ? ` of ${declared[1]} reported` : ""),
      failures,
    };
  },
};
