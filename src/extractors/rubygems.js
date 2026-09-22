// `bundle install` is the first thing a Ruby CI job runs and the first thing that
// fails, and none of the three ways it fails was read at all - each came back as
// "whyitbroke could not identify a diagnostic" with the log handed back.
//
// What makes them hard is that bundler writes prose, not diagnostics: no severity word,
// no `file:line`, and a sentence that wraps across lines mid-clause. So each shape is
// matched whole and read from a bounded region, never by scanning for loose words.

import { withSource } from "../ownership.js";

// Could not find gem 'invoice-formatter' in rubygems repository
// https://rubygems.org/ or installed locally.
//
// The sentence wraps after the source, so the rest of it is on the next line. Reading
// only the first line drops "or installed locally", which is the half that says the gem
// is not anywhere rather than just not in that one repository.
const MISSING = /^(Could not find gem '([^'\n]+)' .+?)[^\S\n]*$/;
// Could not find compatible versions ... then the resolver's explanation, which ends
// "version solving has failed." That last line is the mechanism; the "Because ..." and
// "So, because ..." clauses above it are the reason, and they are the answer.
const CONFLICT = /^Could not find compatible versions[^\S\n]*$/;
const SOLVING_FAILED = /^[^\S\n]*version solving has failed\.[^\S\n]*$/;
// [!] There was an error parsing `Gemfile`: ... . Bundler cannot continue.
const PARSING = /^\[!\] There was an error parsing `([^`\n]+)`:/;
// followed, after the parser's own echo, by where it was:   #  from /path/Gemfile:4
const FROM = /^[^\S\n]*#[^\S\n]+from[^\S\n]+(.+?):(\d+)[^\S\n]*$/;
// and the offending line, marked out of the echoed block:    >  gem "puma" if
const OFFENDING = /^[^\S\n]*>[^\S\n]{2}(.*\S)[^\S\n]*$/;
// The parser draws each complaint under a caret:    |   ^~ expected a predicate ...
const CARET_NOTE = /^[^\S\n]*\|[^\S\n]*\^~*[^\S\n]*(\S.*?)[^\S\n]*$/;

export default {
  name: "bundler",
  // Strings a log has to hold for this parser to read anything from it - see src/router.js.
  signals: ["Could not find gem '", "Could not find compatible versions", "There was an error parsing `"],
  category: "package",
  commands: ["bundle", "bundler"],

  detect: (s) => s.split("\n").some((l) => MISSING.test(l) || CONFLICT.test(l) || PARSING.test(l)),

  extract(s) {
    const lines = s.split("\n");
    const failures = [];

    for (let i = 0; i < lines.length; i++) {
      const missing = lines[i].match(MISSING);
      if (missing) {
        // The rest of the sentence, if it wrapped. It is a continuation only while it
        // is prose that does not start a new one - bundler's next line is as often
        // "Run `bundle install` to install missing gems." which is advice, not this.
        let end = i + 1;
        let rest = "";
        const next = lines[i + 1] ?? "";
        if (next.trim() && !/^[A-Z\[]/.test(next) && !next.startsWith(" ")) { rest = " " + next.trim(); end = i + 2; }
        failures.push(withSource({
          // The gem's name is the site that failed, so it is the subject - and `code`,
          // `subject` and `label` are alternatives, one to a failure. Two gems missing
          // from one Gemfile are two things to fix, which is what a subject groups as.
          subject: missing[2], title: "gem not found", severity: "error",
          message: `${missing[1]}${rest}`,
        }, i, end));
        continue;
      }

      if (CONFLICT.test(lines[i])) {
        // The explanation runs from the first "Because" to "version solving has failed."
        // Bounded both ways: if the closing line is not there, nothing is read, because
        // an unbounded read of prose is how a parser swallows the rest of a CI log.
        const from = lines.findIndex((l, j) => j > i && /^Because\b/.test(l));
        const to = lines.findIndex((l, j) => j > i && SOLVING_FAILED.test(l));
        if (from < 0 || to < from) continue;
        failures.push(withSource({
          title: "version conflict", label: "version conflict", severity: "error",
          message: lines.slice(from, to + 1).map((l) => l.trim()).filter(Boolean).join(" "),
        }, i, to + 1));
        continue;
      }

      const parsing = lines[i].match(PARSING);
      if (parsing) {
        // Where bundler says it was, which it prints after its echo of the source.
        let file, line, stmt, end = i + 1;
        for (let j = i + 1; j < lines.length && j <= i + 24; j++) {
          const from = lines[j].match(FROM);
          if (!from) continue;
          [, file, line] = from;
          end = j + 1;
          for (let k = j + 1; k < lines.length && k <= j + 6; k++) {
            const off = lines[k].match(OFFENDING);
            if (off) { stmt = off[1]; end = k + 1; break; }
          }
          break;
        }
        // What the Ruby parser actually objected to, which is more use than
        // "syntax errors found". The first complaint is the one to fix.
        const note = lines.slice(i, Math.min(lines.length, i + 12)).map((l) => l.match(CARET_NOTE)?.[1]).find(Boolean);
        failures.push(withSource({
          file, line: line ? +line : undefined, stmt,
          title: "parse error", label: "parse error", severity: "error",
          message: note ?? `${parsing[1]} could not be parsed`,
        }, i, end));
      }
    }

    if (!failures.length) return null;
    return { tool: "bundle", failures };
  },
};
