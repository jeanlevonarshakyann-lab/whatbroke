import { isNoise } from "../util.js";

// mocha numbers its failures under a tally, and splits each one over two lines: the
// suite on the numbered line, the test indented under it with a trailing colon.
//
//   1 passing (3ms)
//   2 failing
//
//   1) invoice
//        totals an invoice:
//       AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
//       ...
//       at Context.<anonymous> (test/sum.test.js:6:12)
//
// "N) name" is not mocha's alone - rspec and Playwright both number that way - so the
// tally is what identifies the tool, and rspec's own blocks are told apart by carrying
// a "Failure/Error:" line that mocha never writes.
const TALLY_RE = /^[^\S\n]*(\d+) (?:passing|failing|pending)\b/m;
const FAILING_RE = /^[^\S\n]*(\d+) failing\b/m;
const PASSING_RE = /^[^\S\n]*(\d+) passing\b/m;
const HEAD_RE = /^[^\S\n]*(\d+)\)[^\S\n]+(.*)$/;
const NAME_RE = /^[^\S\n]+(\S.*):[^\S\n]*$/;
// A bare "Error:" is as common as a named class here - a hook that throws, a timeout -
// so the class name cannot require a prefix.
const ERROR_RE = /^[^\S\n]*(\w*(?:Error|Exception)(?:[^\S\n]+\[[\w_]+\])?):[^\S\n]*(.*)$/;
const FRAME_RE = /^[^\S\n]+at[^\S\n]+(?:(.+?)[^\S\n]+\()?(.+?):(\d+):(\d+)\)?[^\S\n]*$/;
// A file mocha could not even load never reaches the tally. Deliberately not anchored:
// such a log is almost entirely stack frames, so a runner prefix and the frames' own
// indentation share a prefix, and stripping it takes the indentation with it. "Exception
// during run:" is distinctive enough to stand without the anchor, and a log that says it
// inside a monorepo runner should still be read.
const LOAD_RE = /^[^\S\n]*Exception during run:[^\S\n]*(.+?):(\d+)[^\S\n]*$/m;
// mocha repeats the test file in the timeout message; the location already says it.
const TRAILING_PATH = /[^\S\n]*\((?:\/|[A-Za-z]:\\)[^)]*\)[^\S\n]*$/;
const MAX_MESSAGE_LINES = 3;

export default {
  name: "mocha",
  category: "test",
  commands: ["mocha", "_mocha"],

  detect: (s) => TALLY_RE.test(s) || LOAD_RE.test(s),

  extract(s) {
    const lines = s.split("\n");
    const failures = [];

    // mocha's detailed blocks come after its tally, and it says how many there are.
    // Both bounds matter: "N) name" belongs to rspec, jasmine, PHPUnit and Playwright
    // too, and jasmine's blocks put "Message:" under the number - a line ending in a
    // colon, which is exactly what mocha writes a test name as. Reading on past its own
    // count claimed jasmine's failures as mocha's whenever both were in one log.
    // No tally, no numbered blocks: mocha only writes them under one. Scanning without
    // it meant a mocha run that never reached its tally - a file that would not load -
    // still read whatever numbered blocks another tool had put in the same log.
    const declared = s.match(FAILING_RE);
    const limit = declared ? +declared[1] : 0;
    const from = declared ? lines.findIndex((l) => FAILING_RE.test(l)) : 0;

    for (let i = from + 1; i < lines.length && failures.length < limit; i++) {
      const head = lines[i].match(HEAD_RE);
      if (!head) continue;
      // The list at the top repeats every number without a body. A real block has the
      // test name on the next line, ending in a colon.
      const named = lines[i + 1]?.match(NAME_RE);
      if (!named) continue;

      const suite = head[2].trim();
      const test = named[1].trim();

      let message = "", code, frames = [];
      for (let j = i + 2; j < lines.length && j <= i + 40; j++) {
        if (HEAD_RE.test(lines[j]) && NAME_RE.test(lines[j + 1] ?? "")) break;
        const f = lines[j].match(FRAME_RE);
        if (f) { frames.push({ fn: f[1] ?? "<anonymous>", file: f[2], line: +f[3], col: +f[4] }); continue; }
        if (frames.length) break;
        const e = lines[j].match(ERROR_RE);
        if (e && !code) { code = e[1].split(/\s+/)[0]; message = e[2].trim(); continue; }
        // the diff mocha prints under an assertion is context, kept briefly
        if (code && lines[j].trim() && message.split("\n").length < MAX_MESSAGE_LINES) {
          message += `\n${lines[j].trim()}`;
        }
      }

      // A timeout unwinds entirely inside node's own timers, so the only frames are
      // internal ones. Reporting "node:internal/timers:585" as the place your test
      // failed is worse than reporting no place at all.
      const mine = frames.filter((f) => !isNoise(f.file) && !/^node:/.test(f.file));
      const at = mine[0];
      failures.push({
        file: at?.file, line: at?.line, col: at?.col,
        title: suite ? `${suite} ${test}` : test,
        subject: suite ? `${suite} ${test}` : test,
        severity: "error",
        message: (message || test).replace(TRAILING_PATH, ""),
        code: undefined,
        trace: mine.length ? mine.slice(0, 4).map((f) => `${f.fn} (${f.file}:${f.line}:${f.col})`) : undefined,
        hiddenFrames: frames.length - mine.length,
      });
      i += 1;
    }

    if (!failures.length) {
      // A file that will not load never reaches the tally, so there is no numbered
      // block to read - just mocha's own line and node's stack under it.
      const at = lines.findIndex((l) => LOAD_RE.test(l));
      const load = at >= 0 ? lines[at].match(LOAD_RE) : null;
      if (load) {
        // mocha writes the class on the line straight under its own. Searching the whole
        // log for one meant that with another tool's output above, that tool's message
        // arrived attached to mocha's file and line - eslint's "Key \"rules\": ..."
        // reported at syn.test.js:2.
        // Blank lines do not count toward the distance - mocha puts several between its
        // own line and node's - so the window is the next few lines that say anything.
        let why = null, seen = 0;
        for (let j = at + 1; j < lines.length && seen < 3; j++) {
          if (!lines[j].trim()) continue;
          seen++;
          const m = lines[j].match(ERROR_RE);
          if (m) { why = m; break; }
        }
        failures.push({
          file: load[1], line: +load[2],
          title: why ? why[1] : "failed to load",
          code: why ? why[1] : undefined,
          label: why ? undefined : "failed to load",
          severity: "error",
          message: why ? why[2].trim() : "mocha could not load this file",
        });
      }
    }
    if (!failures.length) return null;

    const failing = s.match(FAILING_RE), passing = s.match(PASSING_RE);
    const summary = failing
      ? `${failing[1]} failing${passing ? `, ${passing[1]} passing` : ""}`
      : undefined;
    return { tool: "mocha", summary, failures };
  },
};
