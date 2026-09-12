// `mocha --reporter json` - what a pipeline uses when something downstream reads the
// result. Mocha pretty-prints it across forty-odd lines, so unlike eslint's or jest's
// single-line reports it cannot be found by scanning for a line that parses. Nothing
// here could read a word of it, and a real failing run came back with no diagnosis.
//
// The document is found by its own shape rather than by position: an object carrying
// `stats` with a failure count, and a `failures` array. A log can hold other JSON.
import { isNoise } from "../util.js";

const MARKER = /"fullTitle"[^\S\n]*:/;
// The same frame shape mocha's human reporter is read with, so both point at the line
// that threw rather than at the test file as a whole.
const FRAME_RE = /^[^\S\n]+at[^\S\n]+(?:(.+?)[^\S\n]+\()?(.+?):(\d+):(\d+)\)?[^\S\n]*$/;

function firstUserFrame(lines) {
  for (const line of lines) {
    const f = line.match(FRAME_RE);
    if (f && !isNoise(f[2])) return { file: f[2], line: +f[3], col: +f[4] };
  }
  return null;
}

/** The substring starting at `start` that closes its own brace, or null.
 *
 *  Whitespace outside the strings is rewritten to a plain space on the way past. JSON
 *  admits only space, tab, CR and LF between its tokens, and a runner that re-indents
 *  the output it relays - pnpm uses U+2009 THIN SPACE - turns a valid report into one
 *  that will not parse at all. Inside a string the same character is data and is kept. */
function objectAt(text, start) {
  let depth = 0, inString = false, escaped = false;
  const out = [];
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out.push(c);
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    out.push(/\s/.test(c) && !"\t\n\r ".includes(c) ? " " : c);
    if (c === '"') { inString = true; continue; }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return out.join("");
  }
  return null;
}

function mochaReport(text) {
  if (!MARKER.test(text)) return null;
  // Every `{` that opens a line is a candidate; mocha's report is written from column
  // zero, and an indented one is a member of something larger that will be tried first.
  for (const match of text.matchAll(/^[^\S\n]*\{/gm)) {
    const raw = objectAt(text, match.index + match[0].length - 1);
    if (!raw) continue;
    let value;
    try { value = JSON.parse(raw); } catch { continue; }
    if (value && typeof value === "object" && value.stats &&
        Array.isArray(value.failures) && typeof value.stats.failures === "number") return value;
  }
  return null;
}

export default {
  name: "mocha json",
  category: "test",
  commands: ["mocha"],

  detect: (s) => !!mochaReport(s),

  extract(s) {
    const report = mochaReport(s);
    if (!report?.failures?.length) return null;
    const failures = report.failures.map((test) => {
      const stack = String(test.err?.stack ?? "");
      // The stack names the line that threw; `file` names the whole test file. The
      // human reporters point at the line, so this points at the same one.
      const frame = firstUserFrame(stack.split("\n"));
      const name = test.fullTitle || test.title || "test";
      // mocha's JSON keeps the blank line it would have printed around the comparison.
      // That is layout for a terminal, and the human reporter's message does not carry
      // it - so the two say the same thing once it is gone.
      const message = (String(test.err?.message ?? "").trim() ||
        stack.split("\n")[0]?.trim() || name).replace(/\n[^\S\n]*\n/g, "\n");
      return {
        file: frame?.file ?? test.file ?? undefined,
        line: frame?.line, col: frame?.col,
        title: name, subject: name, severity: "error",
        message,
      };
    });
    const passed = Number.isInteger(report.stats?.passes) ? report.stats.passes : 0;
    return {
      tool: "mocha",
      summary: `${failures.length} failing, ${passed} passing`,
      failures,
    };
  },
};
