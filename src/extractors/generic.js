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
  // The classic unix shape - "curl: (7) Failed to connect", "cp: cannot stat",
  // "ssh: ... Connection refused". A bare "prog: message" is far too broad to
  // treat as an error, so it must also say that something did not work.
  /^[a-z][\w.+-]*:\s.*\b(?:failed|failure|cannot|can't|not found|refused|denied|no such|unable to|invalid|missing|timed out|unreachable|does not exist|permission)\b/i,
];
const NOISE = [/^[^\S\n]*at /, /^npm (notice|warn)/, /^[^\S\n]*$/, /^warning:/i];

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

/** Where a message says it happened, if it says at all. */
function locate(lines, i, text) {
  // deno prints the offending source line and a caret between the message and the
  // frames, so stopping at the first line that is not a frame never reaches them.
  for (let j = i + 1; j < lines.length && j <= i + 5; j++) {
    const m = lines[j].match(FRAME_RE);
    if (m) return { file: unfile(m[1]), line: +m[2], col: m[3] ? +m[3] : undefined };
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
    const repeats = (t) => {
      const flat = t.replace(/\s+/g, " ").trim();
      return said.some((prev) => {
        const [x, y] = afterCommonPrefix(prev, flat);
        return x.length > 0 && y.length > 0 && (x.includes(y) || y.includes(x));
      });
    };
    const failures = [];
    for (const h of hits.slice(0, 12)) {
      if (repeats(h.text)) continue;
      said.push(h.text.replace(/\s+/g, " ").trim());
      const loc = h.text.match(/^([^\s:]+):(\d+)(?::(\d+))?:[^\S\n]*(.*)$/);
      if (loc) {
        failures.push({ file: loc[1], line: +loc[2], col: loc[3] ? +loc[3] : undefined, title: "", severity: "error", message: loc[4] });
        continue;
      }
      const at = locate(lines, h.i, h.text);
      failures.push({ ...(at ?? {}), title: "", severity: "error", message: h.text });
      if (failures.length >= 8) break;
    }
    return { tool: "output", failures, guessed: true };
  },
};
