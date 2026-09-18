// minitest - Ruby's own test framework, and the one a Rails application runs - reports
// its run as a line of dots and letters and then each failure as a numbered block:
//
//     1) Failure:
//   ShopTest#test_totals_an_invoice [shop_test.rb:9]:
//   Expected: 1050
//     Actual: 1049
//
//     2) Error:
//   ShopTest#test_reads_the_expiry:
//   KeyError: key not found: "exp"
//       shop_test.rb:14:in `fetch'
//       shop_test.rb:14:in `test_reads_the_expiry'
//
//   3 runs, 2 assertions, 1 failures, 1 errors, 0 skips
//
// A failure is an assertion, and says where it is in brackets. An error is an exception
// the test raised, and says where only in its backtrace, innermost frame first - which
// may be a helper in lib/ rather than the test.
import { isNoise } from "../util.js";
import { withSource } from "../ownership.js";

const BLOCK_RE = /^[^\S\n]*\d+\) (Failure|Error):[^\S\n]*$/;
// The name, which a spec-style test builds with spaces in it, and where it is.
const FAILURE_RE = /^(\S.*?#\S.*?) \[([^\[\]\n]+?):(\d+)\]:[^\S\n]*$/;
const ERROR_RE = /^(\S.*?#\S.*?):[^\S\n]*$/;
// Ruby 3.4 quotes the method as 'Class#name' where earlier rubies wrote `name'.
const FRAME_RE = /^[^\S\n]+(.+?):(\d+):in [`'](.+?)'$/;
const TALLY_RE = /^\d+ runs, \d+ assertions, \d+ failures, \d+ errors, \d+ skips$/m;

export default {
  name: "minitest",
  // Strings a log has to hold for this parser to read anything from it - see src/router.js.
  signals: [" assertions, ", ") Failure:", ") Error:"],
  category: "test",
  commands: ["minitest", "rails"],

  // The tally, or a numbered block whose next line names a test the way minitest does:
  // Class#test. RSpec numbers its blocks too, and writes the example's name on that line.
  detect: (s) => TALLY_RE.test(s) || s.split("\n").some((line, i, lines) =>
    /^[^\S\n]*\d+\) (?:Failure|Error):[^\S\n]*$/.test(line) && (FAILURE_RE.test(lines[i + 1] ?? "") || ERROR_RE.test(lines[i + 1] ?? ""))),

  extract(s) {
    const lines = s.split("\n");
    const failures = [];

    for (let i = 0; i < lines.length; i++) {
      // A skip is numbered like a failure - `2) Skipped:` - and is not one. It ends where
      // every block does, at a blank line, so nothing has to know it is there.
      const block = lines[i].match(BLOCK_RE);
      if (!block) continue;
      // The test's name is on the next line, unless another stream's line landed between
      // the two - stdout and stderr are separate pipes, and a line of npm's chatter in
      // there used to cost the whole failure. It is still minitest's own next line: two
      // lines of somebody else's is no longer a block.
      let named = i + 1;
      let failure = null, error = null;
      for (; named <= i + 2 && named < lines.length; named++) {
        failure = block[1] === "Failure" ? lines[named].match(FAILURE_RE) : null;
        error = block[1] === "Error" ? lines[named].match(ERROR_RE) : null;
        if (failure || error) break;
      }
      if (!failure && !error) continue;

      // What the block says runs to the blank line minitest puts after every block. A diff
      // it draws has no blank line inside it - an empty line of the value is drawn with its
      // marker - and without that bound, a block cut off from its tally ran on into
      // whatever the log held next.
      let end = named + 1;
      while (end < lines.length && lines[end].trim() && !BLOCK_RE.test(lines[end]) && !TALLY_RE.test(lines[end])) end++;
      const body = lines.slice(named + 1, end);

      if (failure) {
        failures.push(withSource({
          file: failure[2], line: +failure[3],
          title: failure[1], subject: failure[1], severity: "error",
          message: body.join("\n").trim() || "assertion failed",
        }, i, end));
        continue;
      }

      // The exception, then its backtrace. Its location is the first frame in the
      // project; a frame inside a gem or the standard library is somebody else's.
      const frames = [];
      const said = [];
      for (const line of body) {
        const frame = line.match(FRAME_RE);
        if (frame) frames.push({ file: frame[1], line: +frame[2], fn: frame[3] });
        else if (!frames.length) said.push(line);
      }
      const mine = frames.filter((f) => !isNoise(f.file));
      const at = mine[0] ?? frames[0];
      const message = said.join("\n").trim();
      failures.push(withSource({
        file: at?.file, line: at?.line,
        title: error[1], subject: error[1], severity: "error",
        message: message || "an exception was raised",
        trace: mine.length ? mine.slice(0, 4).map((f) => `${f.fn} (${f.file}:${f.line})`) : undefined,
        hiddenFrames: frames.length - mine.length || undefined,
      }, i, end));
    }

    if (!failures.length) return null;
    return { tool: "minitest", summary: s.match(TALLY_RE)?.[0], failures };
  },
};
