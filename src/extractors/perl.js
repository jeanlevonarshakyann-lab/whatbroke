// Perl puts the location at the end of the message, in prose:
//
//   Can't call method "render" on an undefined value at p_undef.pl line 3.
//   syntax error at p_syn.pl line 2, near "= ;"
//
// The pattern is greedy on the message so it binds to the LAST "at FILE line N" - a
// message can contain the word "at", and the location is always last.
const DIAGNOSTIC_RE = /^(.+)[^\S\n]at[^\S\n](\S+)[^\S\n]line[^\S\n](\d+)(?:,[^\S\n]*(.+?))?\.?$/;
// Test::More reports where a test failed in a TAP comment - "#   at shop.t line 5." -
// which is the shape above with a hash in front of it. Reading those as dies turned a
// failing Perl suite into failures whose entire message was "#", and hid the test names
// and the got/expected values that the TAP document actually carries.
//
// The rule is what is left of the message once the location is taken off it: a die
// always says something, and here there is nothing but the hash. Testing the start of
// the line instead would have been simpler and wrong - a CI runner stamps its prefix in
// front of the hash, and then the guard misses and the whole document is misread again.
const TAP_COMMENT_MESSAGE = /(?:^|[^\S\n])#[^\S\n]*$/;
// A Perl source file, or one of the two names perl uses for a program with no file.
const PERL_SRC = /\.(?:pl|pm|t|cgi|psgi)$/i;
const NO_FILE = /^(?:-e|-|\(eval \d+\))$/;

// Perl restates a compilation failure once it has unwound, without adding to it. The
// line that said what was wrong came first.
const RESTATES = [
  /^Execution of .+ aborted due to compilation errors\.?$/,
  /^BEGIN failed--compilation aborted at /,
  /^Compilation failed in require at /,
];

// Perl marks nothing: a warning and a fatal die are written in exactly the same shape,
// so the only thing separating them is what the message says. These are perldiag's
// common (W) categories. The list is not exhaustive, and an unlisted warning is reported
// as a failure - which over-reports beside the real one rather than hiding it.
//
// Deliberately not anchored: a CI runner that stamps every line puts its prefix inside
// the message, and an anchored phrase stopped matching - so a wrapped perl log reported
// its warning as a second failure. These phrases are distinctive enough that finding one
// anywhere in a perl diagnostic means it is that warning.
const WARNINGS = [
  /\bUse of uninitialized value\b/,
  /\bArgument ".*" isn't numeric\b/,
  /\bOdd number of elements in (?:hash|anonymous hash)\b/,
  /\bDeep recursion on (?:subroutine|anonymous subroutine)\b/,
  /\bSubroutine \S+ redefined\b/,
  /\bName "\S+" used only once\b/,
  /\bWide character in \b/,
  /\bUseless use of .+ in void context\b/,
  /\bPossible precedence (?:issue|problem)\b/,
  /\bScalar value @\S+ better written as\b/,
];

// The module search path is longer than the diagnosis and never varies.
const INC_LIST = /[^\S\n]*\(@INC (?:contains|entries checked):[^)]*\)/;

/** A match whose message is only a hash is Test::More reporting, not Perl dying. */
function tapComment(m) {
  return m && TAP_COMMENT_MESSAGE.test(m[1]) ? null : m;
}

export default {
  name: "perl",
  category: "runtime",
  commands: ["perl", "prove"],

  // "<message> at <file> line <N>" is prose, so the file has to look like Perl's, or the
  // log has to carry one of perl's own restatement lines.
  detect: (s) => {
    const lines = s.split("\n");
    if (lines.some((l) => RESTATES.some((re) => re.test(l)))) return true;
    return lines.some((l) => {
      const m = tapComment(l.match(DIAGNOSTIC_RE));
      return !!m && (PERL_SRC.test(m[2]) || NO_FILE.test(m[2]));
    });
  },

  extract(s) {
    const failures = [];
    let warnings = 0;
    for (const line of s.split("\n")) {
      if (RESTATES.some((re) => re.test(line))) continue;
      const m = tapComment(line.match(DIAGNOSTIC_RE));
      if (!m) continue;
      if (!PERL_SRC.test(m[2]) && !NO_FILE.test(m[2])) continue;

      const message = m[1].replace(INC_LIST, "").trim();
      if (WARNINGS.some((re) => re.test(message))) { warnings++; continue; }

      failures.push({
        file: NO_FILE.test(m[2]) ? undefined : m[2],
        line: +m[3],
        title: "error", label: "error", severity: "error",
        // "near \"= ;\"" is what the parser choked on, which is the useful half of a
        // syntax error.
        message: m[4] ? `${message} (${m[4]})` : message,
      });
    }
    if (!failures.length) return null;
    const n = failures.length;
    const summary = n > 1 || warnings
      ? `${n} error${n === 1 ? "" : "s"}${warnings ? `, ${warnings} warning${warnings === 1 ? "" : "s"}` : ""}`
      : undefined;
    return { tool: "perl", summary, failures };
  },
};
