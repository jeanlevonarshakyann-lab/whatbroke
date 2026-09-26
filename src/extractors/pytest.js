import { isNoise } from "../util.js";
import { alsoFrom, withSource } from "../ownership.js";

// pytest's traceback style is a flag, and CI configs set it constantly. Only the default
// was read properly:
//
//   --tb=short   the location moved to the TOP of the block as "file:line: in name",
//                and the pattern below looked for one exception word after the colon,
//                so every failure came back with no location at all.
//   --tb=line    no per-test block is printed, so nothing was found and the fallback
//                scraped the summary AND the one-line locations - two failures as four.
//   --tb=no      no block either, and nothing but the summary to read.
//   --tb=native  a Python traceback instead of pytest's own, with no "E" lines, so the
//                run was left to the traceback parser: right failures, wrong tool, and
//                no count of what passed.
//
// What every style does print is the short test summary, and it is authoritative: it
// names each failed test and what it raised. So it is the backbone, and the traceback -
// in whichever style - is only asked where.
// A parameter id is arbitrary display text, and may contain spaces. The spaced dash is
// pytest's separator between the complete node id and its one-line explanation.
const SUMMARY_ENTRY_RE = /^(?:FAILED|ERROR)[^\S\n]+((?:.+?::.+?)|(?:.+?\.[A-Za-z0-9]+))(?:[^\S\n]+-[^\S\n]+(.*))?[^\S\n]*$/;
const SUMMARY_HEAD_RE = /^=+[^\S\n]+short test summary info[^\S\n]+=+$/;
// --tb=line writes one line per failure: "path:11: KeyError: 'taxrate'".
const ONE_LINE_RE = /^(.+?):(\d+):[^\S\n]+(\S.*?)[^\S\n]*$/;
// "path:line:" followed by the exception, by nothing, or - in --tb=short - by
// "in <function>", which names the frame rather than what was raised.
const TRAILING_RE = /^(.+?):(\d+):[^\S\n]*(?:in[^\S\n]+\S+|(\w[\w.]*))?[^\S\n]*$/;
// One path is another when the two name the same file at different depths: the summary
// writes it relative to the root, a traceback sometimes absolutely.
const sameFile = (a, b) => {
  if (!a || !b) return false;
  const x = String(a).replace(/\\/g, "/"), y = String(b).replace(/\\/g, "/");
  return x === y || x.endsWith("/" + y) || y.endsWith("/" + x);
};
// a Python frame, for --tb=native
const FRAME_RE = /^[^\S\n]*File[^\S\n]+"(.+?)",[^\S\n]+line[^\S\n]+(\d+)/;
// "test_shop.py::TestClass::test_method" is titled "TestClass.test_method" in a block
// banner, so the summary's ids are shaped the same way to match.
function idParts(id) {
  const [file, ...rest] = id.split("::");
  return { file, title: rest.join(".") || file };
}

export default {
  name: "pytest",
  // Strings a log has to hold for this parser to read anything from it - see src/router.js.
  signals: ["test session starts", "short test summary info"],
  category: "test",
  commands: ["pytest", "py.test"],
  detect: (s) =>
    /^=+ test session starts =+$/m.test(s) ||
    /^=+ short test summary info =+$/m.test(s),

  extract(s) {
    const lines = s.split("\n");
    const failures = [];

    // FAILURES / ERRORS sections are split by ____ test name ____ banners.
    const blocks = [];
    let cur = null;
    lines.forEach((l, i) => {
      const b = l.match(/^_{3,}[^\S\n]+(.+?)[^\S\n]+_{3,}$/);
      // A block is its banner down to the last line under it that is not blank.
      if (b) { cur = { title: b[1], body: [], at: i, end: i + 1 }; blocks.push(cur); return; }
      if (/^=+ .* =+$/.test(l)) { cur = null; return; }
      if (cur) { cur.body.push(l); if (l.trim()) cur.end = i + 1; }
    });

    for (const blk of blocks) {
      // trailing "path:line: ExceptionType"
      let file, line, kind, trailingIndex = -1;
      for (let i = blk.body.length - 1; i >= 0; i--) {
        const m = blk.body[i].match(TRAILING_RE);
        // Group 3 is the exception - there is no group 4, so `kind` was always undefined
        // and a block whose only words were its trailing "test_x.py:2: RuntimeError"
        // reported an empty message.
        if (m && !isNoise(m[1])) { file = m[1]; line = +m[2]; kind = m[3]; trailingIndex = i; break; }
      }
      // The failing statement, which pytest marks with ">", and the "E" explanation under
      // it. The two belong together: pytest writes the marked line, then at most a caret
      // row under the part it evaluated, then the explanation. Nothing else comes between
      // them.
      //
      // That matters because a block runs from its own banner to the next one, so in a log
      // where two printings of one run are interleaved it can absorb the other printing's
      // marked line - and then quote it. The same test read twice, with one quote its own
      // and one belonging to a different test, is two readings that agree on file, line,
      // message and name and are told apart only by a quote that one of them borrowed.
      // Requiring the marked line to be the one this explanation hangs off leaves the
      // borrowed one where it was found.
      const marked = (i) => /^>\s/.test(blk.body[i] ?? "");
      const between = (i) => /^[^\S\n]*\^+[^\S\n]*$/.test(blk.body[i] ?? "") || (blk.body[i] ?? "").trim() === "";
      const stmt = [];
      for (let i = 0; i < blk.body.length; i++) {
        if (!/^E\s/.test(blk.body[i])) continue;
        let j = i - 1;
        while (j >= 0 && between(j)) j--;
        if (marked(j)) stmt.push(blk.body[j].slice(1).trim());
        while (i + 1 < blk.body.length && /^E\s/.test(blk.body[i + 1])) i++;   // one explanation, not one per line
      }
      const expl = blk.body.filter((l) => /^E\s/.test(l)).map((l) => l.slice(1).trim());
      // Some pytest tracebacks end with a bare exception type instead of an E line.
      // Its adjacent marked statement still belongs to this failure.
      if (!expl.length && !stmt.length && trailingIndex >= 0) {
        let j = trailingIndex - 1;
        while (j >= 0 && between(j)) j--;
        if (marked(j)) stmt.push(blk.body[j].slice(1).trim());
      }
      // --tb=native prints a Python traceback, which has neither mark. The exception is
      // its last unindented line, and the frame that matters is the last one outside
      // pytest's own machinery.
      let native;
      if (!expl.length && !stmt.length && !kind) {
        for (let i = blk.body.length - 1; i >= 0; i--) {
          const t = blk.body[i];
          if (!t.trim() || /^[^\S\n]/.test(t)) continue;
          if (/^Traceback[^\S\n]+\(most recent call last\)/.test(t)) break;
          native = t.trim();
          break;
        }
        if (native) {
          for (let i = blk.body.length - 1; i >= 0; i--) {
            const f = blk.body[i].match(FRAME_RE);
            if (f && !isNoise(f[1])) { file ??= f[1]; line ??= +f[2]; break; }
          }
        }
      }
      if (!expl.length && !stmt.length && !native && !kind) continue;
      failures.push(withSource({
        file, line,
        title: blk.title, subject: blk.title, severity: "error",
        message: (expl.length ? expl : [native ?? kind ?? ""]).join("\n"),
        stmt: stmt[0],
      }, blk.at, blk.end));
    }

    // "===== 3 failed, 2 passed in 0.01s =====", or with -q the same line
    // with no decoration at all: "85 failed, 1973 passed, 25 skipped in 3.58s"
    let summary;
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i].match(/^=+[^\S\n]+(.*?(?:failed|passed|error).*?)[^\S\n]+=+$/i)
             || lines[i].match(/^((?:\d+ (?:failed|passed|skipped|deselected|xfailed|xpassed|error|errors|warning|warnings)(?:, )?)+ in [\d.]+s.*)$/i);
      if (m) { summary = m[1]; break; }
    }
    // The summary is read whatever the blocks gave, because a log can hold two runs -
    // `pytest a; pytest b`, or a collect error and then a real run - and only one of
    // them may have printed blocks. Gating this on having found nothing lost the second
    // run's failures without a word, which is exactly what the same-tool sweep is for.
    // A test a block already reported is not added twice.
    {
      // --tb=line also prints "path:line: <message>" per failure. The message is the
      // same string the summary carries, so the two are matched on it rather than on
      // the order they happen to appear in.
      //
      // One entry per message was one too few. Two tests that raise the same exception -
      // the same KeyError from two files, which is the ordinary shape of a shared fixture
      // breaking - overwrote each other, and BOTH failures were then reported at the last
      // one's file and line. Every candidate is kept, and the summary's own filename says
      // which is which.
      const located = new Map();
      lines.forEach((l, i) => {
        const m = l.match(ONE_LINE_RE);
        if (!m || isNoise(m[1])) return;
        const at = { file: m[1], line: +m[2], i };
        const seen = located.get(m[3]);
        if (seen) seen.push(at); else located.set(m[3], [at]);
      });
      /** Where --tb=line put this summary entry, or nothing.
       *
       *  A lone candidate needs no disambiguating and is used as it stands - it may well
       *  name a helper rather than the test, which is where the exception actually came
       *  from and is the more useful line. Where several share a message, only the one in
       *  the summary's own file is this entry's; if that does not single one out, the
       *  failure keeps the file the summary named and goes without a line. A line that
       *  might belong to another test is worse than no line: it sends the reader to code
       *  that is fine. */
      const locate = (file, message) => {
        const all = located.get(message);
        if (!all) return null;
        if (all.length === 1) return all[0];
        const mine = all.filter((c) => sameFile(c.file, file));
        return mine.length === 1 ? mine[0] : null;
      };
      // Every summary section, not the first: two pytest runs in one log have one each,
      // and reading only the first dropped the second run's failures entirely.
      const entries = [];
      for (let start = 0; start < lines.length; start++) {
        if (!SUMMARY_HEAD_RE.test(lines[start])) continue;
        for (let i = start + 1; i < lines.length && !/^=+/.test(lines[i]); i++) entries.push(i);
      }
      // A summary line naming a failure already read from its block is another place
      // that failure was read.
      const also = (index, entry) => { failures[index] = alsoFrom(failures[index], entry, entry + 1); };
      // and it is one line about one failure. The name alone used to decide, so two tests
      // called test_total - in different files, or different classes, which is what test
      // suites are full of - folded into each other and the run reported one failure where
      // its own tally said two. A failure already spoken for cannot be claimed again.
      const claimed = new Set();
      const claim = (index) => { claimed.add(index); return index; };
      for (const entry of entries) {
        const m = lines[entry].match(SUMMARY_ENTRY_RE);
        if (!m) continue;
        const { file, title } = idParts(m[1]);
        const message = (m[2] ?? "").trim();
        // A collection error is summarised as bare "ERROR test_broken.py" - no test id
        // and no message - so it says nothing the block above it has not already said.
        const collected = message ? -1 : failures.findIndex((f, i) =>
          !claimed.has(i) && (f.file === file || String(f.title).includes(file)));
        if (collected >= 0) { also(claim(collected), entry); continue; }
        // The whole node id first: a log can hold one run printed twice - as the default
        // traceback and again with --tb=line - or two runs of the same suite, and the same
        // test read from both is one failure. This is what tells that apart from two
        // different tests that happen to share a name, which the bare name cannot.
        const sameTest = failures.findIndex((f) => f.subject === m[1]);
        if (sameTest >= 0) { also(sameTest, entry); continue; }
        // Otherwise the name decides which block this line is about - a block's banner
        // names the test but not its file, so there is nothing else to go on. Comparing
        // the messages too looked more careful and was less safe: a block whose text
        // arrives damaged - two tools sharing a pipe - no longer matched its own summary
        // line, and the failure was then counted twice. What the name now has to be is
        // unclaimed: two tests called test_total are two, not one read twice.
        const named = failures.findIndex((f, i) => !claimed.has(i) && f.title === title);
        if (named >= 0) {
          // pytest's node id is the whole name of the test, and the only part of it the
          // banner does not carry is the file. It is what tells two tests of one name
          // apart, so it becomes the subject - the name --since-last remembers them by.
          // Set, not copied onto a new object: the range a failure was read from is a
          // non-enumerable property, and spreading one silently leaves it behind.
          failures[named].subject = m[1];
          also(claim(named), entry);
          continue;
        }
        const at = locate(file, message);
        // The summary line, and the one-line location --tb=line printed for it.
        const failure = withSource({
          file: at?.file ?? file, line: at?.line,
          title, subject: m[1], severity: "error",
          message: message || title,
        }, entry, entry + 1);
        claim(failures.length);
        failures.push(at ? alsoFrom(failure, at.i, at.i + 1) : failure);
      }
    }
    if (!failures.length && !summary) return null;
    return { tool: "pytest", summary, failures };
  },
};
