import { isNoise } from "../util.js";

// An uncaught Ruby exception names where it was raised, the method it was raised in, the
// message, and the class - all on one line - and then unwinds:
//
//   deep.rb:3:in `fetch': key not found: :price (KeyError)
//           from deep.rb:3:in `block in total'
//           from deep.rb:6:in `<main>'
//
// Ruby 3.4 changed the method quoting from `name' to 'Class#name'. Both are accepted
// here; only the older form is in the corpus, because that is the ruby this was
// captured on.
const RAISE_RE = /^(.+?):(\d+):in [`'](.+?)':[^\S\n]+(.*?)[^\S\n]+\(([A-Z][\w:]*(?:Error|Exception|Interrupt|Signal|Timeout))\)$/;
const FRAME_RE = /^[^\S\n]+from[^\S\n]+(.+?):(\d+):in [`'](.+?)'$/;
// A file that will not parse never runs, so there is no exception and no unwind - just
// the line and what the parser expected.
const SYNTAX_RE = /^(.+?):(\d+):[^\S\n]+(syntax error,?[^\S\n]*.*)$/;
// Ruby offers a correction under a NameError. It is the answer often enough to keep.
const SUGGEST_RE = /^Did you mean\?[^\S\n]*(.+)$/;

export default {
  name: "ruby",
  category: "runtime",
  commands: ["ruby", "rake", "irb"],

  // "file:line:in `method'" is Ruby's alone - no other tool writes the method between
  // the location and the message - so either shape is enough on its own.
  detect: (s) =>
    RAISE_RE.test(s.split("\n").find((l) => RAISE_RE.test(l)) ?? "") ||
    SYNTAX_RE.test(s.split("\n").find((l) => SYNTAX_RE.test(l)) ?? ""),

  extract(s) {
    const lines = s.split("\n");
    const failures = [];

    for (let i = 0; i < lines.length; i++) {
      const raise = lines[i].match(RAISE_RE);
      if (raise) {
        const frames = [];
        for (let j = i + 1; j < lines.length; j++) {
          const f = lines[j].match(FRAME_RE);
          if (!f) break;
          frames.push({ file: f[1], line: +f[2], fn: f[3] });
        }
        // A `require` that fails is raised inside rubygems, so the deepest frame is the
        // stdlib and the useful one is the caller's. Where every frame is the library's,
        // the raise site is all there is and it stays.
        const raised = { file: raise[1], line: +raise[2], fn: raise[3] };
        const mine = [raised, ...frames].filter((f) => !isNoise(f.file));
        const at = mine[0] ?? raised;

        let message = raise[4];
        const hint = lines[i + 1]?.match(SUGGEST_RE);
        if (hint) message += `\nDid you mean? ${hint[1].trim()}`;

        // `trace` is rendered as text, one frame per line, and the first entry is the
        // one already shown as the failure's own location - the renderer skips it. The
        // library frames are counted rather than listed: for a missing gem they are the
        // whole of rubygems and none of them is yours.
        const shown = mine.slice(0, 4).map((f) => `${f.fn} (${f.file}:${f.line})`);
        failures.push({
          file: at.file, line: at.line,
          title: raise[5], code: raise[5], severity: "error",
          message, stmt: undefined,
          trace: shown.length ? shown : undefined,
          hiddenFrames: 1 + frames.length - mine.length,
        });
        i += frames.length;
        continue;
      }

      const syntax = lines[i].match(SYNTAX_RE);
      if (syntax) {
        failures.push({
          file: syntax[1], line: +syntax[2],
          title: "syntax error", label: "syntax error", severity: "error",
          message: syntax[3],
        });
      }
    }

    if (!failures.length) return null;
    const n = failures.length;
    return { tool: "ruby", summary: n > 1 ? `${n} errors` : undefined, failures };
  },
};
