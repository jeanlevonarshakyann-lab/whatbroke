// `cargo fmt --check` - and `rustfmt --check`, which is the program it runs - prints a
// unified diff of what it would rewrite, one block per region:
//
//   Diff in /home/dev/shop/src/main.rs:10:
//   -    let items = vec![1,2,3];
//   +    let items = vec![1, 2, 3];
//        println!("{}", total(&items));
//
// It exits non-zero, so a job fails on it, and none of this was read: a Rust CI job whose
// only failure was formatting came back as "no parser for this tool" with the diff handed
// back whole, which is the shape this tool exists to replace.
//
// A block is a PLACE, not a file. rustfmt numbers the line each region starts at, and one
// file with three unformatted regions gets three blocks - so unlike the other format
// checks here, which can only name files, this one says where.
import { counted } from "../util.js";
import { withSource } from "../ownership.js";

// Whatever precedes the last two colons is the path, so a Windows drive letter survives.
const HEAD_RE = /^Diff in (.+):(\d+):[^\S\n]*$/;
// A diff body is only removed, added and context lines. A context line for a blank source
// line is a single space, never an empty line - so an empty line ends the block, and a
// block in a mixed log cannot swallow whatever was printed after it.
const BODY_RE = /^[-+ ]/;

export default {
  name: "cargo fmt",
  // Strings a log has to hold for this parser to read anything from it - see src/router.js.
  signals: ["Diff in "],
  category: "lint",
  commands: ["rustfmt"],

  detect: (s) => s.split("\n").some((line) => HEAD_RE.test(line)),

  extract(s) {
    const lines = s.split("\n");
    const failures = [];
    const files = new Set();
    for (let i = 0; i < lines.length; i++) {
      const head = lines[i].match(HEAD_RE);
      if (!head) continue;
      let end = i + 1;
      while (end < lines.length && BODY_RE.test(lines[end])) end++;
      // The first line it would remove is the source as it stands. A removed line can
      // itself begin with "-", so the marker comes off by position rather than by match.
      const removed = lines.slice(i + 1, end).find((line) => line.startsWith("-"));
      files.add(head[1]);
      failures.push(withSource({
        file: head[1], line: +head[2],
        title: "not formatted", label: "not formatted", severity: "error",
        message: "this is not formatted as rustfmt would write it",
        stmt: removed?.slice(1).trim() || undefined,
      }, i, end));
    }
    if (!failures.length) return null;
    // Counting files rather than blocks, and saying what failed rather than what "would
    // be reformatted": the run exited non-zero, and a headline has to read like it.
    return {
      tool: "cargo fmt",
      summary: `${counted(files.size, "file")} failed the format check`,
      failures,
    };
  },
};
