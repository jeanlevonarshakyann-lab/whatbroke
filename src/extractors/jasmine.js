import { isNoise } from "../util.js";

// jasmine gathers its failures under a "Failures:" heading and gives each one a
// message and a stack, both labelled:
//
//   Failures:
//   1) invoice totals an invoice
//     Message:
//       Expected 1049 to be 1050.
//     Stack:
//           at <Jasmine>
//           at UserContext.<anonymous> (file:///abs/jas/sum.spec.js:2:54)
//
//   2 specs, 2 failures
//
// "N) name" is not jasmine's alone - rspec, mocha and Playwright all number that way -
// so the tally is what identifies the tool. jasmine's own frames read "<Jasmine>" and
// carry no file at all, which is convenient: they cannot be mistaken for yours.
const TALLY_RE = /^[^\S\n]*(\d+) specs?, (\d+) failures?(?:, (\d+) pending)?/m;
const HEAD_RE = /^[^\S\n]*(\d+)\)[^\S\n]+(\S.*?)[^\S\n]*$/;
const MESSAGE_RE = /^[^\S\n]*Message:[^\S\n]*$/;
const STACK_RE = /^[^\S\n]*Stack:[^\S\n]*$/;
const FRAME_RE = /^[^\S\n]+at[^\S\n]+(?:(.+?)[^\S\n]+\()?(?:file:\/\/)?(\/[^\s()]+?):(\d+):(\d+)\)?[^\S\n]*$/;
const MAX_MESSAGE_LINES = 4;
const unfile = (p) => (p.startsWith("file://") ? decodeURIComponent(p.slice(7)) : p);

export default {
  name: "jasmine",
  category: "test",
  commands: ["jasmine", "jasmine-node"],

  detect: (s) => TALLY_RE.test(s) && /^[^\S\n]*Failures:[^\S\n]*$/m.test(s),

  extract(s) {
    const lines = s.split("\n");
    const failures = [];

    // jasmine's blocks live between its "Failures:" heading and its tally, and nowhere
    // else. "N) name" belongs to rspec, mocha, PHPUnit and Playwright too, so a scan of
    // the whole log read their blocks as jasmine's the moment both tools were present -
    // twelve ordered pairs, all of them jasmine against mocha or PHPUnit.
    const from = lines.findIndex((l) => /^[^\S\n]*Failures:[^\S\n]*$/.test(l));
    if (from < 0) return null;
    let to = lines.findIndex((l, i) => i > from && TALLY_RE.test(l));
    if (to < 0) to = lines.length;

    for (let i = from + 1; i < to; i++) {
      const head = lines[i].match(HEAD_RE);
      if (!head) continue;

      const message = [];
      const frames = [];
      let inMessage = false, inStack = false;
      for (let j = i + 1; j < to && j <= i + 40; j++) {
        if (HEAD_RE.test(lines[j])) break;
        if (TALLY_RE.test(lines[j])) break;
        if (MESSAGE_RE.test(lines[j])) { inMessage = true; inStack = false; continue; }
        if (STACK_RE.test(lines[j])) { inStack = true; inMessage = false; continue; }
        if (inStack) {
          const f = lines[j].match(FRAME_RE);
          // jasmine's own frames say "<Jasmine>" and name no file, so they never match
          if (f && !isNoise(unfile(f[2]))) {
            frames.push({ fn: f[1] ?? "<anonymous>", file: unfile(f[2]), line: +f[3], col: +f[4] });
          }
          continue;
        }
        if (inMessage && lines[j].trim() && message.length < MAX_MESSAGE_LINES) message.push(lines[j].trim());
      }

      // Only a numbered block that said something is a failure; the summary line at the
      // top of a run repeats the numbers with nothing under them.
      if (!message.length && !frames.length) continue;
      const at = frames[0];
      failures.push({
        file: at?.file, line: at?.line, col: at?.col,
        title: head[2], subject: head[2], severity: "error",
        message: message.join("\n") || head[2],
        trace: frames.length ? frames.slice(0, 4).map((f) => `${f.fn} (${f.file}:${f.line}:${f.col})`) : undefined,
      });
      i += 1;
    }

    if (!failures.length) return null;
    const t = s.match(TALLY_RE);
    return {
      tool: "jasmine",
      summary: t ? `${t[2]} of ${t[1]} spec${t[1] === "1" ? "" : "s"} failed` : undefined,
      failures,
    };
  },
};
