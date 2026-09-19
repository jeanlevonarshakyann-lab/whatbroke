// `gofmt -d` prints a unified diff of what it would rewrite, one per file:
//
//   diff cart/cart.go.orig cart/cart.go
//   --- cart/cart.go.orig
//   +++ cart/cart.go
//   @@ -1,10 +1,10 @@
//    package cart
//   -type Cart struct{
//   +type Cart struct {
//
// It exits non-zero, so a job fails on it, and none of it was read: a Go CI job whose only
// failure was formatting came back with no parser and the diff handed back whole.
//
// A hunk is a PLACE. The file is named once in the header and each @@ says where in it, so
// a file with two unformatted regions is two places - the same shape `cargo fmt --check`
// gets read as, and more than prettier, black or deno fmt can say.
//
// What is NOT read is `gofmt -l`, which is how most CI jobs run it: that prints bare
// filenames and nothing else, with no word, no punctuation and no shape to tell it from
// any other list of paths a build prints. There is nothing there to claim safely.
import { counted } from "../util.js";
import { withSource } from "../ownership.js";

// "diff <path>.orig <path>", and the two have to be the same path - which is what keeps
// this off `git diff`'s "diff --git a/x b/x" and off a plain `diff a b`.
const HEAD_RE = /^diff[^\S\n]+(\S+)\.orig[^\S\n]+(\S+)[^\S\n]*$/;
const HUNK_RE = /^@@[^\S\n]+-(\d+)(?:,(\d+))?[^\S\n]+\+\d+(?:,\d+)?[^\S\n]+@@/;
// A hunk body is removed, added and context lines. "---" and "+++" belong to the file
// header above the first hunk, never inside one.
const BODY_RE = /^[-+ ]/;

const named = (line) => {
  const m = line.match(HEAD_RE);
  return m && m[1] === m[2] ? m[1] : null;
};

export default {
  name: "gofmt",
  // Strings a log has to hold for this parser to read anything from it - see src/router.js.
  signals: [".orig "],
  category: "lint",
  commands: ["gofmt", "go"],

  detect: (s) => s.split("\n").some((line) => named(line) !== null),

  extract(s) {
    const lines = s.split("\n");
    const failures = [];
    const files = new Set();
    let file = null, header = 0;
    for (let i = 0; i < lines.length; i++) {
      const head = named(lines[i]);
      if (head) { file = head; header = i; files.add(head); continue; }
      if (!file) continue;
      // What ends this file's diff is another diff beginning. gofmt is not the only thing
      // that draws @@ hunks: minitest writes `--- expected` / `+++ actual` / `@@` between
      // two values that differ, and so does PHPUnit - so a job running gofmt and then a
      // test suite puts both in one log, and a file that stayed current for the rest of it
      // read that suite's diff as more unformatted Go. A `---` line that is not this
      // file's own is somebody else's header.
      //
      // Deliberately not "the first line that is not part of a diff": a context line is
      // marked with an ASCII space, and holding the block to that threw the rest of a file
      // away whenever anything re-indented the log or interleaved a line into it. What is
      // being guarded against is another diff, so that is what is looked for.
      if (lines[i].startsWith("---")) {
        if (lines[i].trim() !== `--- ${file}.orig`) file = null;
        continue;
      }
      const hunk = lines[i].match(HUNK_RE);
      if (!hunk) continue;
      let end = i + 1;
      while (end < lines.length && BODY_RE.test(lines[end]) && !HUNK_RE.test(lines[end])) end++;
      // Where in the file the change actually starts, and the line as it stands there.
      //
      // Not the hunk's own number: a hunk opens with up to three unchanged lines of
      // context, so `@@ -2,10` on a file whose first changed line is line 5 sent the
      // reader three lines early - and to a blank one, since that is what the context
      // began with. The quoted source came from the first removed line and the number
      // from the hunk, so the two did not even describe the same place, and the check
      // that refuses to print source which no longer matches could not see it: the line
      // it compared was blank, and everything starts with nothing.
      //
      // Counting forward through the body gives both from the same line: a context line
      // and a removed line each advance the original file, an added one does not exist
      // in it yet. The marker comes off by position, because a removed line can itself
      // begin with "-".
      let at = +hunk[1], removed;
      for (const line of lines.slice(i + 1, end)) {
        if (line.startsWith("-")) { removed = line; break; }
        if (line.startsWith("+")) continue;
        at++;
      }
      // Interleaved output can contain lines beginning with a space, just like diff
      // context. If they push the first removed line beyond the hunk's declared old
      // range, its location is no longer trustworthy. Later hunks may still be sound.
      if (removed && at >= +hunk[1] + +(hunk[2] ?? 1)) continue;
      // From the header, not from the @@: the hunk says where in the file, and only the
      // header says which file. Two hunks of one file both name it, so both ranges start
      // there - each was read partly from that line, and a range has to hold what it is
      // evidence for.
      failures.push(withSource({
        file, line: at,
        title: "not formatted", label: "not formatted", severity: "error",
        message: "this is not formatted as gofmt would write it",
        stmt: removed?.slice(1).trim() || undefined,
      }, header, end));
    }
    if (!failures.length) return null;
    return {
      tool: "gofmt",
      summary: `${counted(files.size, "file")} failed the format check`,
      failures,
    };
  },
};
