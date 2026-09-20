// `terraform fmt -check -diff` names each file it would rewrite and draws the change:
//
//   main.tf
//   --- old/main.tf
//   +++ new/main.tf
//   @@ -1,12 +1,12 @@
//    resource "aws_s3_bucket" "invoices" {
//   -    bucket = "shop-invoices"
//   +  bucket = "shop-invoices"
//
// It exits 3, so a job fails on it, and none of it was read - the whole diff came back
// handed over, which is the shape this tool exists to replace.
//
// A hunk is a PLACE. The file is named in the header and each @@ says where in it, the
// same way `gofmt -d` and `cargo fmt --check` are read. What is not read is a plain
// `terraform fmt -check`, which prints bare filenames and nothing else: there is no word,
// no punctuation and no shape in a list of paths to tell it from any other list a build
// prints.
import { counted } from "../util.js";
import { withSource } from "../ownership.js";

// terraform spells its two halves `old/<path>` and `new/<path>`, and the path is the same
// in both. Nothing else writes a diff that way - git writes `a/<path>` and `b/<path>` -
// so the pair is what identifies this and keeps it off every other diff a build prints.
const OLD_RE = /^---[^\S\n]+old\/(\S.*?)[^\S\n]*$/;
const NEW_RE = /^\+\+\+[^\S\n]+new\/(\S.*?)[^\S\n]*$/;
const HUNK_RE = /^@@[^\S\n]+-(\d+)(?:,(\d+))?[^\S\n]+\+\d+(?:,\d+)?[^\S\n]+@@/;
const BODY_RE = /^[-+ ]/;

/** The file this pair of header lines is about, or null if they are not such a pair. */
const named = (lines, i) => {
  const old = lines[i].match(OLD_RE);
  const fresh = old && (lines[i + 1] ?? "").match(NEW_RE);
  return fresh && fresh[1] === old[1] ? old[1] : null;
};

export default {
  name: "terraform fmt",
  // Strings a log has to hold for this parser to read anything from it - see src/router.js.
  signals: ["--- old/"],
  category: "lint",
  commands: ["terraform", "tofu"],

  detect: (s) => {
    const lines = s.split("\n");
    return lines.some((_, i) => named(lines, i) !== null);
  },

  extract(s) {
    const lines = s.split("\n");
    const failures = [];
    const files = new Set();
    let file = null, header = 0, lastLine = 0;
    for (let i = 0; i < lines.length; i++) {
      const head = named(lines, i);
      if (head) { lastLine = 0; file = head; header = i; files.add(head); i++; continue; }
      if (!file) continue;
      // Another diff beginning is what ends this one. minitest and PHPUnit draw `---` and
      // @@ hunks of their own between two values that differ, and a file that stayed
      // current for the rest of the log would have those read as more unformatted HCL.
      if (lines[i].startsWith("---")) { file = null; continue; }
      const hunk = lines[i].match(HUNK_RE);
      if (!hunk) continue;
      // A diff's hunks are ordered and disjoint: each starts after the last one ended, and
      // no file has two regions beginning at the same line. A hunk that does not is not
      // this file's - it is another diff's, woven into this one, carrying a line number
      // that happens to collide. Refusing it is what keeps a shredded log from reporting
      // one place twice, which is the one thing such a log still has to get right.
      if (+hunk[1] <= lastLine) continue;
      lastLine = +hunk[1];
      let end = i + 1;
      while (end < lines.length && BODY_RE.test(lines[end]) && !HUNK_RE.test(lines[end])) end++;
      // Where in the file the change starts, and the line as it stands there. Not the
      // hunk's own number: a hunk opens with up to three unchanged lines of context, so
      // the number and the quoted source described different places. Counting forward
      // gives both from the same line - a context line and a removed line each advance
      // the original file, an added one does not exist in it yet. The marker comes off by
      // position, because a removed line can itself begin with "-".
      let at = +hunk[1], removed;
      for (const line of lines.slice(i + 1, end)) {
        if (line.startsWith("-")) { removed = line; break; }
        if (line.startsWith("+")) continue;
        at++;
      }
      // Interleaved output can look like diff context. A removed line beyond the
      // hunk's declared old-file range has no trustworthy location; later hunks may.
      if (removed && at >= +hunk[1] + +(hunk[2] ?? 1)) continue;
      // From the header: only it says which file, and a range has to hold what it is
      // evidence for.
      failures.push(withSource({
        file, line: at,
        title: "not formatted", label: "not formatted", severity: "error",
        message: "this is not formatted as terraform fmt would write it",
        stmt: removed?.slice(1).trim() || undefined,
      }, header, end));
    }
    if (!failures.length) return null;
    return {
      tool: "terraform fmt",
      summary: `${counted(files.size, "file")} failed the format check`,
      failures,
    };
  },
};
