import { isNoise, tailFirst } from "../util.js";
import { withSource } from "../ownership.js";

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
// `file:line:in `method': message (Class)` - the pattern
//   /^(.+?):(\d+):in [`'](.+?)':[^\S\n]+(.*?)[^\S\n]+\(([A-Z][\w:]*(?:Error|Exception|Interrupt|Signal|Timeout))\)$/
// matched without reading a long line again from every colon in it. The method is lazy
// too: each `':` after its first character, in turn.
export const raiseLine = (line) => tailFirst(line, {
  tail: /\(([A-Z][\w:]*(?:Error|Exception|Interrupt|Signal|Timeout))\)$/, spaceBefore: 1, emptyMessage: true,
  heads: function* (l, c, clear) {
    const place = /:(\d+):in [`']/y;
    for (let p = l.indexOf(":", 1); p !== -1 && p < c; p = l.indexOf(":", p + 1)) {
      if (!clear(0, p)) continue;
      place.lastIndex = p;
      const m = place.exec(l);
      if (!m) continue;
      const method = place.lastIndex;
      for (let k = l.indexOf("':", method + 1); k !== -1 && k < c && clear(method, k); k = l.indexOf("':", k + 1)) {
        yield { end: k + 2, groups: [l.slice(0, p), m[1], l.slice(method, k)] };
      }
    }
  },
});
const FRAME_RE = /^[^\S\n]+from[^\S\n]+(.+?):(\d+):in [`'](.+?)'$/;
// A file that will not parse never runs, so there is no exception and no unwind - just
// the line and what the parser expected.
const SYNTAX_RE = /^(.+?):(\d+):[^\S\n]+(syntax error,?[^\S\n]*.*)$/;
// Ruby offers a correction under a NameError. It is the answer often enough to keep.
const SUGGEST_RE = /^Did you mean\?[^\S\n]*(.+)$/;

export default {
  name: "ruby",
  // Strings a log has to hold for this parser to read anything from it - see src/router.js.
  signals: [":in ", "syntax error"],
  category: "runtime",
  commands: ["ruby", "rake", "irb"],

  // "file:line:in `method'" is Ruby's alone - no other tool writes the method between
  // the location and the message - so either shape is enough on its own.
  detect: (s) =>
    s.split("\n").some((l) => raiseLine(l)) ||
    SYNTAX_RE.test(s.split("\n").find((l) => SYNTAX_RE.test(l)) ?? ""),

  extract(s) {
    const lines = s.split("\n");
    const failures = [];

    for (let i = 0; i < lines.length; i++) {
      const raise = raiseLine(lines[i]);
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
        // The raise, and the frames it unwound through.
        failures.push(withSource({
          file: at.file, line: at.line,
          title: raise[5], code: raise[5], severity: "error",
          message, stmt: undefined,
          trace: shown.length ? shown : undefined,
          hiddenFrames: 1 + frames.length - mine.length,
        }, i, i + 1 + frames.length));
        i += frames.length;
        continue;
      }

      const syntax = lines[i].match(SYNTAX_RE);
      if (syntax) {
        failures.push(withSource({
          file: syntax[1], line: +syntax[2],
          title: "syntax error", label: "syntax error", severity: "error",
          message: syntax[3],
        }, i, i + 1));
      }
    }

    if (!failures.length) return null;
    const n = failures.length;
    return { tool: "ruby", summary: n > 1 ? `${n} errors` : undefined, failures };
  },
};
