import { joinSources, withSource } from "../ownership.js";

/** Last resort: no parser matched. Surface the lines most likely to matter. */
const SIGNAL = [
  /^[^\S\n]*(error|fatal|panic|exception)\b/i,
  // Case-insensitive because plenty of tools write it lower: jq says "parse error:",
  // openssl says "…:error:09FFF06C:PEM routines:…". Requiring a capital E meant a
  // perfectly clear diagnostic came back as nothing at all.
  /\b(error|exception|panic|assertion\w*)[^\S\n]*:/i,
  /^[^\S\n]*(FAIL|FAILED|✗|✖|×)\b/,
  /^[^\s:]+:\d+(:\d+)?:\s/,
  // Ruby names the method between the location and the message, so there is no space
  // after the line number: "bad.rb:2:in `f\': undefined method ...". Without this a
  // plain `ruby script.rb` crash produced no diagnosis at all.
  /^\S+:\d+:in [`'"]/,
  // Two more words real tools use where none of the others appear. `set -u` is how a
  // careful CI script is written, and the shell reports it as "deploy.sh: line 4: FOO:
  // unbound variable" - nothing else in that sentence says anything went wrong. sed and
  // awk say "unterminated address regex" and "unterminated string", and so do several
  // compilers. Both are rare enough outside a diagnostic to carry their own weight.
  // The classic unix shape - "curl: (7) Failed to connect", "cp: cannot stat",
  // "ssh: ... Connection refused". A bare "prog: message" is far too broad to
  // treat as an error, so it must also say that something did not work.
  // The vocabulary is the failure words a unix tool actually uses, and it was written
  // around verbs. That missed the nouns: `tar: Error opening archive: Unrecognized
  // archive format` and `awk: syntax error at source line 1` both name themselves and
  // then say plainly that something broke, and neither produced any diagnosis at all -
  // the word is not immediately before a colon, so the pattern above it never fired.
  /^[a-z][\w.+-]*:\s.*\b(?:failed|failure|cannot|can't|not found|refused|denied|no such|unable to|invalid|missing|timed out|unreachable|does not exist|permission|errors?|fatal|panic|unrecogni[sz]ed|unsupported|corrupt(?:ed)?|malformed|illegal|unbalanced|truncated|unbound|unterminated)\b/i,
];
// A line whose first mark is "|" is the renderer drawing the source, not a diagnostic:
// rustc, swift and ruff all echo the offending line and hang an annotation off it, and
// the annotation repeats the message word for word. Counting both said swiftc reported
// four errors for two, and the repeat check cannot catch it - the two copies differ by
// their prefixes, not by a prefix one of them has.
const ANNOTATION = /^[^\S\n]*\d*[^\S\n]*\|/;
// "note:", "help:" and "hint:" introduce the rest of a diagnostic, never the diagnostic.
// Widening the vocabulary below to catch tar's "Error opening archive" also caught pip's
// "note: This error originates from a subprocess, and is likely not a problem with pip",
// which says the opposite of a diagnosis.
const CONTINUATION = /^[^\S\n]*(?:note|help|hint):/i;
// A warning is not why a run failed, and `warning:` at the start of a line was already
// skipped. The same word after a location was not: gcc, clang, javac and go all write
// `Orders.java:8: warning: [rawtypes] found raw type: List`, and the location shape above
// claimed it. A javac run that compiled cleanly and warned four times came back as
// "3 errors". A note or a hint after a location is the same aside, told the same way.
//
// The colon does not always come straight after the word. A linter that reports which
// rule fired names it there instead - oxlint writes
// `shop.js:1:7: warning eslint(no-unused-vars): Variable 'unused' is ...` - and an
// oxlint run that exited 0 on three warnings came back as "3 errors" for exactly the
// reason javac's did. What may sit between is a rule name, optionally qualified by the
// plugin that owns it; anything longer is prose, and prose after a severity word means
// the word was not a severity at all.
const LOCATED_ASIDE = /^[^\s:]+:\d+(?::\d+)?:[^\S\n]*(?:warning|note|help|hint)\b(?:\[[^\]\n]*\]|[^\S\n]+[\w.-]+(?:\([^)\n]*\))?)?:/i;
const NOISE = [/^[^\S\n]*at /, /^npm (notice|warn)/, /^[^\S\n]*$/, /^warning:/i, LOCATED_ASIDE, ANNOTATION, CONTINUATION];

// Almost every runtime prints "something went wrong" and then says where, on the next
// line or inside the message itself. Reading only the first line finds the right words
// and throws away the only actionable part.
//   bun    error: ...        \n      at boom (/app/crash.ts:1:36)
//   deno   error: Uncaught...\n    at file:///app/dcrash.ts:1:32
//   ruby   bad.rb:2:in `f\': undefined method ...
//   php    ... on null in /app/bad.php:2
const FRAME_RE = /^[^\S\n]*at[^\S\n]+(?:.*?\()?((?:file:\/\/)?[^\s()]+?):(\d+)(?::(\d+))?\)?[^\S\n]*$/;
const INLINE_LOC_RE = /[^\S\n](?:in|at)[^\S\n]((?:\/|[A-Za-z]:\\)[^\s:]+?):(\d+)\b/;
const unfile = (p) => (p.startsWith("file://") ? decodeURIComponent(p.slice(7)) : p);

/** Where a message says it happened, if it says at all - and the line of the frame that
 *  said so, when it is a frame. */
function locate(lines, i, text) {
  // deno prints the offending source line and a caret between the message and the
  // frames, so stopping at the first line that is not a frame never reaches them.
  for (let j = i + 1; j < lines.length && j <= i + 5; j++) {
    const m = lines[j].match(FRAME_RE);
    if (m) return { file: unfile(m[1]), line: +m[2], col: m[3] ? +m[3] : undefined, frame: j };
  }
  const inline = text.match(INLINE_LOC_RE);
  return inline ? { file: inline[1], line: +inline[2] } : null;
}

export default {
  name: "generic",
  category: "unknown",
  commands: [],
  detect: () => true,
  extract(s) {
    const lines = s.split("\n");
    const hits = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (NOISE.some((r) => r.test(l))) continue;
      if (SIGNAL.some((r) => r.test(l))) hits.push({ i, text: l.trim() });
    }
    if (!hits.length) return null;
    // One failure told twice is not two. PHP writes a fatal to both the error log and
    // stdout, differing only by a "PHP " prefix and a space, and counting both says the
    // run failed twice as badly as it did.
    const said = [];
    // Compare what differs, not what happens to sit in front of it. PHP's two copies
    // differ by a "PHP " that is at the start of the line - until a runner prefixes
    // every line, and then it is in the middle and a plain containment test stops
    // seeing it. Dropping the prefix the two share puts it back at the start.
    const afterCommonPrefix = (a, b) => {
      let i = 0;
      while (i < a.length && i < b.length && a[i] === b[i]) i++;
      return [a.slice(i), b.slice(i)];
    };
    // Which earlier line this one repeats, if any.
    const repeats = (t) => {
      const flat = t.replace(/\s+/g, " ").trim();
      return said.findIndex((prev) => {
        const [x, y] = afterCommonPrefix(prev, flat);
        return x.length > 0 && y.length > 0 && (x.includes(y) || y.includes(x));
      });
    };
    const failures = [];
    for (const h of hits.slice(0, 12)) {
      // A line told twice is read from both places.
      const earlier = repeats(h.text);
      if (earlier >= 0) { failures[earlier] = joinSources(failures[earlier], withSource({}, h.i, h.i + 1)); continue; }
      said.push(h.text.replace(/\s+/g, " ").trim());
      const loc = h.text.match(/^([^\s:]+):(\d+)(?::(\d+))?:[^\S\n]*(.*)$/);
      if (loc) {
        // A line or a column of 0 points at nothing. `<unknown>:0:` is how swift and clang
        // say there is no location, and a column of 0 is a tool counting from 0 - pylint
        // does - which one line is not enough to correct for. Neither is kept.
        const line = +loc[2] || undefined;
        const col = line && +loc[3] ? +loc[3] : undefined;
        failures.push(withSource({ file: loc[1], line, col, title: "", severity: "error", message: loc[4] }, h.i, h.i + 1));
        continue;
      }
      const { frame, ...at } = locate(lines, h.i, h.text) ?? {};
      // The line, and the frame under it that said where.
      failures.push(withSource({ ...at, title: "", severity: "error", message: h.text }, h.i, frame === undefined ? h.i + 1 : frame + 1));
      if (failures.length >= 8) break;
    }
    return { tool: "output", failures, guessed: true };
  },
};
