import { isNoise } from "../util.js";

// `deno run` and `deno check`, as opposed to `deno test` - which has its own parser and
// its own shape. Deno writes the word in lower case and puts its frames on file:// URLs:
//
//   error: Uncaught (in promise) Error: payment gateway unreachable
//       throw new Error("payment gateway unreachable");
//             ^
//       at Gateway.charge (file:///abs/d1.ts:3:11)
//       at file:///abs/d1.ts:6:15
//
// Node writes the class capitalised at column zero and does not lead with "error:", so
// the two do not collide. Without this the whole thing was a guess: it found the file
// and the line but kept "error: " and the file:// URL inside the message, and lost a
// `deno check` diagnostic entirely - reporting "Type checking failed." while the TS code,
// the explanation and the location sat above it.
const ERR_RE = /^error: (?:Uncaught(?: \(in promise\))? )?(?:([\w$]*(?:Error|Exception)): )?(.+)$/;
// `deno check` writes tsc's code in its own shape - "TS2322 [ERROR]: ..." - where tsc
// itself writes "error TS2322: ...".
const CHECK_RE = /^(TS\d+) \[ERROR\]: (.+)$/;
const FRAME_RE = /^[^\S\n]+at (?:(.+?) \()?(file:\/\/\S+?|\/\S+?):(\d+):(\d+)\)?[^\S\n]*$/;
// deno draws the offending source under a syntax error, gutter-first.
const GUTTER_RE = /^[^\S\n]*\d*[^\S\n]*\|/;
const CARET_RE = /^[^\S\n]*\^+[^\S\n]*$/;
// "Type checking failed." is the tally, not the diagnosis - the TS lines above it are.
const TALLY_RE = /^error: (?:Type checking failed\.|Build failed\.)$/;

const unfile = (p) => (p.startsWith("file://") ? decodeURIComponent(p.slice(7)) : p);

export default {
  name: "deno",
  category: "runtime",
  commands: ["deno"],

  detect: (s) => {
    // `deno test` has its own parser and its own shape, and writes an ERRORS header over
    // a tally. Without this exclusion both claimed the same log - harmlessly, since this
    // one reads nothing out of it, but a parser that claims a log it cannot read is noise
    // in the collision matrix.
    const lines = s.split("\n");
    const testStart = lines.findIndex((l) => /^[^\S\n]*ERRORS[^\S\n]*$/.test(l));
    const testEnd = testStart < 0 ? -1 : lines.findIndex((l, i) => i >= testStart && /^error: Test failed$/.test(l));
    const outsideTest = (_, i) => testStart < 0 || i < testStart || (testEnd >= 0 && i > testEnd);
    if (lines.some((l, i) => outsideTest(l, i) && CHECK_RE.test(l))) return true;
    // "error: ..." on its own belongs to half the tools in existence, so it has to be
    // corroborated by a frame on a URL, which is deno's alone among them.
    return lines.some((l, i) => outsideTest(l, i) && ERR_RE.test(l)) &&
      lines.some((l, i) => outsideTest(l, i) && /^[^\S\n]+at .*file:\/\//.test(l));
  },

  extract(s) {
    const lines = s.split("\n");
    const failures = [];
    let checked = false;
    const testStart = lines.findIndex((l) => /^[^\S\n]*ERRORS[^\S\n]*$/.test(l));
    const testEnd = testStart < 0 ? -1 : lines.findIndex((l, i) => i >= testStart && /^error: Test failed$/.test(l));

    for (let i = 0; i < lines.length; i++) {
      if (testStart >= 0 && i >= testStart && (testEnd < 0 || i <= testEnd)) continue;
      if (TALLY_RE.test(lines[i])) continue;
      const check = lines[i].match(CHECK_RE);
      const err = !check && lines[i].match(ERR_RE);
      if (!check && !err) continue;
      if (check) checked = true;

      // The location is on the frames below, past whatever source deno drew in between.
      // The first frame is close: the message, at most a few lines of echoed source and
      // a caret, then the stack. Searching further meant that in a log holding more than
      // one tool an "error:" line belonging to somebody else reached down and adopted
      // deno's frames - cargo ends a build with "error: could not compile ...", and that
      // became a deno failure at a TypeScript file nothing had reported.
      const FIRST_FRAME = 5;
      const frames = [];
      for (let j = i + 1; j < lines.length && j <= i + 12; j++) {
        // A diagnostic cannot own a stack that another diagnostic stands in front of.
        // Bounding the distance was not enough on its own: cargo's "error: could not
        // compile ..." sits three lines above deno's frame once the two logs are
        // concatenated, which is well inside any sane window - but deno's own message
        // is in between, and that is what settles it.
        if (ERR_RE.test(lines[j]) || CHECK_RE.test(lines[j])) break;
        const f = lines[j].match(FRAME_RE);
        if (f) {
          if (!frames.length && j - i > FIRST_FRAME) break;
          frames.push({ fn: f[1] ?? "<anonymous>", file: unfile(f[2]), line: +f[3], col: +f[4] });
          continue;
        }
        if (frames.length) break;
        if (!lines[j].trim() || GUTTER_RE.test(lines[j]) || CARET_RE.test(lines[j])) continue;
        // Anything else is deno echoing the offending line, which comes before the caret.
        if (j - i > 3) break;
      }
      const user = frames.filter((f) => !isNoise(f.file));
      const at = user[0] ?? frames[0];
      if (!at && !check) continue;

      // A module it could not resolve names the missing file as a URL inside the message.
      const message = (check ? check[2] : err[2]).replace(/"file:\/\/(\S+?)"/g, (_, p) => `"${decodeURIComponent(p)}"`);

      failures.push({
        file: at?.file, line: at?.line, col: at?.col,
        title: check ? check[1] : (err[1] ?? "error"),
        code: check ? check[1] : err[1],
        label: check || err[1] ? undefined : "error",
        severity: "error", message,
        trace: user.slice(0, 4).map((f) => `${f.fn} (${f.file}:${f.line}:${f.col})`),
        hiddenFrames: frames.length - user.length,
      });
      i += frames.length;
    }

    if (!failures.length) return null;
    const n = failures.length;
    return {
      tool: checked ? "deno check" : "deno",
      summary: n > 1 ? `${n} error${n > 1 ? "s" : ""}` : undefined,
      failures,
    };
  },
};
