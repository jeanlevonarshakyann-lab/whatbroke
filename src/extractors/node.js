import { isNoise } from "../util.js";

const ERR_RE = /^(?:Uncaught )?((?:[A-Z]\w*)?(?:Error|Exception)(?:\s\[[\w_]+\])?): ?(.*)$/;
// ESM reports every path as a file:// URL, which is not something that can be opened -
// so source context was never shown for a module, and the location read as a URL.
const unfile = (p) => (p?.startsWith("file://") ? decodeURIComponent(p.slice(7)) : p);

/** Line numbers that sit inside a <failure>/<error> element's body. */
function xmlBodyLines(lines) {
  const inside = new Set();
  let open = null;
  for (let i = 0; i < lines.length; i++) {
    if (open) {
      inside.add(i);
      if (new RegExp(`</${open}>`).test(lines[i])) open = null;
      continue;
    }
    const start = lines[i].match(/<(failure|error)\b[^>]*>/);
    if (!start) continue;
    // A self-closing tag is the whole element and holds nothing after it. The test for
    // it was the closing tag alone, and `<error ... />` has none - so shellcheck's
    // checkstyle report, which is nothing but self-closing errors, opened a region that
    // never closed and swallowed the rest of the log. A Node crash printed after one
    // read as somebody's report of a crash and was dropped entirely.
    if (/\/>$/.test(start[0])) continue;
    // ...and so does one that closes on its own line.
    if (!new RegExp(`</${start[1]}>`).test(lines[i].slice(lines[i].indexOf(start[0]) + start[0].length))) {
      open = start[1];
    }
  }
  return inside;
}

export default {
  name: "node",
  category: "runtime",
  commands: ["node"],
  detect: (s) => /^[^\S\n]+at .+\(.+:\d+:\d+\)$/m.test(s) || /^[^\S\n]+at .+:\d+:\d+$/m.test(s),

  extract(s) {
    const lines = s.split("\n");
    const OTHER_DIAGNOSTIC = /^(?:error|Error|warning):[^\S\n]/;
    const FRAME_GAP = 3;
    const SOURCE_GAP = 4;
    const failures = [];

    // A JUnit-shaped report carries the failing tool's stack verbatim inside <failure>,
    // and mocha's xunit reporter writes it unescaped and unindented - so it reads exactly
    // like a Node crash. It is not one: it is somebody's report OF one, already read by
    // the parser that owns the document, and taking it too reported the same failure
    // twice, titled with the error class instead of the test's name.
    const reported = xmlBodyLines(lines);

    for (let errIdx = 0; errIdx < lines.length; errIdx++) {
      if (reported.has(errIdx)) continue;
      const error = lines[errIdx].match(ERR_RE);
      if (!error) continue;

      // Frames follow the error closely. A diagnostic cannot own a stack that another
      // diagnostic stands in front of, even when the distance would otherwise fit.
      const frames = [];
      for (let i = errIdx + 1; i < lines.length; i++) {
        if (ERR_RE.test(lines[i]) || OTHER_DIAGNOSTIC.test(lines[i])) break;
        const m = lines[i].match(/^[^\S\n]+at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/);
        if (!m) { if (frames.length || i - errIdx > FRAME_GAP) break; else continue; }
        frames.push({ fn: m[1] ?? "<anonymous>", file: unfile(m[2]), line: +m[3], col: +m[4] });
      }
      const user = frames.filter((f) => !isNoise(f.file));

      // Uncaught syntax/import failures put source and a caret immediately above this
      // exception. Searching any earlier part of a mixed log borrows another tool's
      // source, so the window is intentionally small and walks backward from here.
      let stmt, header;
      for (let i = errIdx - 1; i >= 0 && i >= errIdx - SOURCE_GAP; i--) {
        if (/^[^\S\n]*\^+[^\S\n]*$/.test(lines[i]) && i >= 1) {
          stmt = lines[i - 1].trim();
          // A path, not a sentence. `^(\S.*?):(\d+)$` accepts anything ending in a
          // number, and black's "error: cannot format cantparse.py: Cannot parse: 1:7"
          // ends in one - under a caret and a source line, which is node's exact shape,
          // so node read that whole sentence as the file its error came from.
          //
          // Colons cannot be what rules it out: node writes "file:///abs/syn.mjs:1".
          // Whitespace can - a path has none, and a sentence has plenty.
          const h = lines[i - 2]?.match(/^(\S+):(\d+)$/);
          if (h) header = { file: unfile(h[1]), line: +h[2] };
          break;
        }
        if (ERR_RE.test(lines[i]) || OTHER_DIAGNOSTIC.test(lines[i])) break;
      }

      // An exception-shaped line with neither its own stack nor its own source header
      // belongs to another tool. Keep scanning: a mixed log can contain a Python
      // KeyError before the real Node exception.
      if (!frames.length && !header) continue;
      const usable = (loc) => (loc && !isNoise(loc.file) ? loc : null);
      const top = user[0] ?? usable(header) ?? usable(frames[0]);
      failures.push({
        file: top?.file, line: top?.line, col: top?.col,
        title: error[1], code: error[1], severity: "error", message: error[2], stmt,
        trace: user.slice(0, 4).map((f) => `${f.fn} (${f.file}:${f.line}:${f.col})`),
        hiddenFrames: frames.length - user.length,
      });
    }

    if (!failures.length) return null;
    return { tool: "node", failures };
  },
};
