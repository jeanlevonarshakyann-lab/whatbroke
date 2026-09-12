import { isNoise } from "../util.js";

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
const SUMMARY_ENTRY_RE = /^(?:FAILED|ERROR)[^\S\n]+(\S+?)(?:[^\S\n]+-[^\S\n]+(.*))?[^\S\n]*$/;
const SUMMARY_HEAD_RE = /^=+[^\S\n]+short test summary info[^\S\n]+=+$/;
// --tb=line writes one line per failure: "path:11: KeyError: 'taxrate'".
const ONE_LINE_RE = /^(.+?):(\d+):[^\S\n]+(\S.*?)[^\S\n]*$/;
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
    for (const l of lines) {
      const b = l.match(/^_{3,}[^\S\n]+(.+?)[^\S\n]+_{3,}$/);
      if (b) { cur = { title: b[1], body: [] }; blocks.push(cur); continue; }
      if (/^=+ .* =+$/.test(l)) { cur = null; continue; }
      if (cur) cur.body.push(l);
    }

    for (const blk of blocks) {
      // trailing "path:line: ExceptionType"
      let file, line, kind;
      for (let i = blk.body.length - 1; i >= 0; i--) {
        // "path:line:" followed by the exception, by nothing, or - in --tb=short - by
        // "in <function>", which names the frame rather than what was raised.
        const m = blk.body[i].match(/^(.+?):(\d+):[^\S\n]*(?:in[^\S\n]+\S+|(\w[\w.]*))?[^\S\n]*$/);
        if (m && !isNoise(m[1])) { file = m[1]; line = +m[2]; kind = m[4]; break; }
      }
      // the failing statement (pytest marks it with ">") and the "E" explanation
      const stmt = blk.body.filter((l) => /^>\s/.test(l)).map((l) => l.slice(1).trim());
      const expl = blk.body.filter((l) => /^E\s/.test(l)).map((l) => l.slice(1).trim());
      // --tb=native prints a Python traceback, which has neither mark. The exception is
      // its last unindented line, and the frame that matters is the last one outside
      // pytest's own machinery.
      let native;
      if (!expl.length && !stmt.length) {
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
      if (!expl.length && !stmt.length && !native) continue;
      failures.push({
        file, line,
        title: blk.title, subject: blk.title, severity: "error",
        message: (expl.length ? expl : [native ?? kind ?? ""]).join("\n"),
        stmt: stmt[0],
      });
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
      const located = new Map();
      for (const l of lines) {
        const m = l.match(ONE_LINE_RE);
        if (m && !isNoise(m[1])) located.set(m[3], { file: m[1], line: +m[2] });
      }
      // Every summary section, not the first: two pytest runs in one log have one each,
      // and reading only the first dropped the second run's failures entirely.
      const entries = [];
      for (let start = 0; start < lines.length; start++) {
        if (!SUMMARY_HEAD_RE.test(lines[start])) continue;
        for (let i = start + 1; i < lines.length && !/^=+/.test(lines[i]); i++) entries.push(lines[i]);
      }
      for (const entry of entries) {
        const m = entry.match(SUMMARY_ENTRY_RE);
        if (!m) continue;
        const { file, title } = idParts(m[1]);
        const message = (m[2] ?? "").trim();
        // A collection error is summarised as bare "ERROR test_broken.py" - no test id
        // and no message - so it says nothing the block above it has not already said.
        if (!message && failures.some((f) => f.file === file || String(f.title).includes(file))) continue;
        // The name alone decides. Comparing the messages too looked more careful and was
        // less safe: a block whose text arrives damaged - two tools sharing a pipe - no
        // longer matched its own summary line, and the failure was then counted twice.
        if (failures.some((f) => f.title === title)) continue;
        const at = located.get(message);
        failures.push({
          file: at?.file ?? file, line: at?.line,
          title, subject: title, severity: "error",
          message: message || title,
        });
      }
    }
    if (!failures.length && !summary) return null;
    return { tool: "pytest", summary, failures };
  },
};
