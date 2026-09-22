// `composer install` is to a PHP CI job what `bundle install` is to a Ruby one: the
// first thing it runs and the first thing that fails. None of the ways it fails was
// read - each came back as "whyitbroke could not identify a diagnostic".
//
// composer says almost everything twice. A resolution failure is a headline, then the
// numbered problems, then "Potential causes:" with four guesses, then a link to the
// troubleshooting guide. Only the numbered problems say what happened; the rest is a
// manual. It also opens with two lines about the root package version and the missing
// lock file that are warnings about the run, not the failure - and one of them contains
// "could not", which is exactly the kind of line a loose parser claims.

import { withSource } from "../ownership.js";

// Your requirements could not be resolved to an installable set of packages.
//
//   Problem 1
//     - Root composer.json requires vendor/x, it could not be found in any version, ...
const UNRESOLVED = /^Your requirements could not be resolved to an installable set of packages\.[^\S\n]*$/;
const PROBLEM = /^[^\S\n]{2}Problem[^\S\n]+(\d+)[^\S\n]*$/;
const CAUSE = /^[^\S\n]{4}-[^\S\n]+(\S.*?)[^\S\n]*$/;
// Everything composer prints after the problems to be helpful rather than to say what
// went wrong. "Potential causes" is a list of guesses about a problem already stated.
const ADVICE = /^(?:Potential causes:|Read <|[^\S\n]*see <|Use the option|Alternatively|$)/;
// What the problem says is required - "Root composer.json requires vendor/pkg" or
// "... requires php ^5.3". Two packages missing are two things to fix, so the required
// one is the subject. Anchored on the word, because the same line goes on to say "but
// your php version (8.5.10) does not satisfy" and the name there is not the requirement.
// A bare name with no vendor is composer's platform set - php, ext-mbstring, lib-icu -
// which is a package to composer like any other.
const REQUIRED = /\brequires[^\S\n]+([a-z0-9](?:[a-z0-9._-]*[a-z0-9])?(?:\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)?)/;

// The other family: a boxed fatal, which composer draws under the class that raised it.
//
//   In JsonFile.php line 398:
//                                        <- blank, inside the box
//     "./composer.json" does not contain valid JSON
//     Parse error on line 4:
const BOXED = /^In[^\S\n]+(\S+\.php)[^\S\n]+line[^\S\n]+(\d+):[^\S\n]*$/;
const BOXED_BODY = /^[^\S\n]{2}(\S.*?)[^\S\n]*$/;
// Where the offending file actually is, when the message names it: `"./composer.json"`
const QUOTED_FILE = /^"([^"\n]+)"[^\S\n]+(?:does not|is not|could not)/;
const AT_LINE = /^(?:Parse error|Syntax error)[^\S\n]+on[^\S\n]+line[^\S\n]+(\d+)/i;

export default {
  name: "composer",
  // Strings a log has to hold for this parser to read anything from it - see src/router.js.
  signals: ["Your requirements could not be resolved", "  Problem ", "does not contain valid JSON", "In "],
  category: "package",
  commands: ["composer"],

  detect(s) {
    const lines = s.split("\n");
    // A boxed error alone is not composer's: symfony/console draws that box for every
    // console application there is. It is composer's when composer's own vocabulary is
    // in the box, or when the resolver spoke.
    if (lines.some((l) => UNRESOLVED.test(l))) return true;
    const boxed = lines.findIndex((l) => BOXED.test(l));
    return boxed >= 0 && lines.slice(boxed, boxed + 8).some((l) => /composer\.(json|lock)/.test(l));
  },

  extract(s) {
    const lines = s.split("\n");
    const failures = [];

    for (let i = 0; i < lines.length; i++) {
      if (UNRESOLVED.test(lines[i])) {
        // Each "Problem N" owns the "- ..." lines under it, and the block ends at the
        // first line that is neither - which is what keeps "Potential causes:" and the
        // troubleshooting link out, and keeps a CI log's next tool out with them.
        for (let j = i + 1; j < lines.length; j++) {
          if (ADVICE.test(lines[j])) { if (!PROBLEM.test(lines[j])) continue; }
          if (!PROBLEM.test(lines[j])) continue;
          for (let k = j + 1; k < lines.length; k++) {
            const cause = lines[k].match(CAUSE);
            if (!cause) { if (lines[k].trim() === "") continue; break; }
            failures.push(withSource({
              subject: cause[1].match(REQUIRED)?.[1],
              title: "unresolved requirement", severity: "error", message: cause[1],
            }, k, k + 1));
          }
        }
        // The resolver said its piece; nothing below it is a second failure.
        break;
      }

      const boxed = lines[i].match(BOXED);
      if (!boxed) continue;
      // The box's body. Two things say where it ends, and what they keep out is the
      // command's own usage line - composer prints it after a boxed error, and it is one
      // line long enough to bury the failure. The box is closed by a blank line, and
      // every line inside it is indented by two while the usage line starts at the
      // margin. Either alone excludes it; both are kept because each is true of the
      // shape, and a box that loses its blank line still has its indent.
      const body = [];
      let end = i + 1;
      for (let j = i + 1; j < lines.length && j <= i + 20; j++) {
        const m = lines[j].match(BOXED_BODY);
        if (!m) { if (body.length) break; continue; }
        body.push(m[1]);
        end = j + 1;
      }
      if (!body.length) continue;
      failures.push(withSource({
        // composer names the file it could not read inside the message. That is where
        // to look; JsonFile.php is composer's own source and is nobody's business.
        file: body[0].match(QUOTED_FILE)?.[1],
        line: body.map((l) => l.match(AT_LINE)?.[1]).find(Boolean)
          ? +body.map((l) => l.match(AT_LINE)?.[1]).find(Boolean) : undefined,
        // composer prints no identifier for these at all: the box is headed by its own
        // source file, which is nobody's business. What they have in common is that
        // composer itself refused, which is the class, so that is the label.
        title: "composer error", label: "composer error", severity: "error",
        message: body.join("\n"),
      }, i, end));
    }

    if (!failures.length) return null;
    return { tool: "composer", failures };
  },
};
