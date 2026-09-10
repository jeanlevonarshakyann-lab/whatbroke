import { isNoise } from "../util.js";

// node writes stack paths as file:// URLs when a module throws; bun writes plain paths,
// but a bun process running an ESM entry can produce either.
const unfile = (p) => (p.startsWith("file://") ? decodeURIComponent(p.slice(7)) : p);

// `bun test`:
//
//   (fail) suite > name > should do the thing [3.10ms]
//   274 |         expect(fn(input)).toEqual(expected);
//                                   ^
//   error: expect(received).toEqual(expected)
//
//   - { "path": "/" }
//   + false
//
//   - Expected  - 4
//   + Received  + 1
//
//         at <anonymous> (/abs/path/src/index.spec.ts:274:27)
//
// Note bun writes "error:" at the start of a line, which the cargo parser also
// looks for - so this must be registered ahead of it.
const FAIL_RE = /^\(fail\)[^\S\n]+(.+?)(?:[^\S\n]+\[[\d.]+m?s\])?[^\S\n]*$/;
const ERROR_RE = /^error:[^\S\n]*(.+)$/;
const AT_RE = /^[^\S\n]*at[^\S\n]+.*?\((.+?):(\d+):(\d+)\)[^\S\n]*$/;
const SOURCE_RE = /^[^\S\n]*\d+[^\S\n]*\|/;              // bun's echoed source context
const CARET_RE = /^[^\S\n]*\^+[^\S\n]*$/;
const DIFF_COUNT_RE = /^[-+][^\S\n]*(Expected|Received)[^\S\n]+[-+][^\S\n]*\d+[^\S\n]*$/;
const MAX_MESSAGE_LINES = 4;

export default {
  name: "bun test",
  category: "test",
  commands: ["bun"],
  detect: (s) => /^\(fail\)[^\S\n]+/m.test(s) &&
    (/^Ran \d+ tests? across/m.test(s) || /^[^\S\n]*\d+ fail[^\S\n]*$/m.test(s)),

  extract(s) {
    const lines = s.split("\n");
    const failures = [];

    for (let i = 0; i < lines.length; i++) {
      const head = lines[i].match(FAIL_RE);
      if (!head) continue;

      let file, line, col;
      const msg = [];
      for (let j = i + 1; j < lines.length && !FAIL_RE.test(lines[j]); j++) {
        const at = lines[j].match(AT_RE);
        if (at) { if (!file) { file = at[1]; line = +at[2]; col = +at[3]; } continue; }
        const t = lines[j].trim();
        if (!t || msg.length >= MAX_MESSAGE_LINES) continue;
        // the echoed source, its caret, and the diff's own tallies are not the message
        if (SOURCE_RE.test(lines[j]) || CARET_RE.test(lines[j]) || DIFF_COUNT_RE.test(t)) continue;
        const err = t.match(ERROR_RE);
        msg.push(err ? err[1] : t);
      }
      if (!msg.length) continue;
      failures.push({ file, line, col, title: head[1], subject: head[1], severity: "error", message: msg.join("\n") });
    }

    if (!failures.length) return null;

    const num = (k) => {
      const m = s.match(new RegExp(String.raw`^[^\S\n]*(\d+)[^\S\n]+${k}[^\S\n]*$`, "m"));
      return m ? +m[1] : null;
    };
    const [failed, passed] = [num("fail"), num("pass")];
    const bits = [];
    if (failed) bits.push(`${failed} fail`);
    if (passed) bits.push(`${passed} pass`);

    return { tool: "bun test", summary: bits.length ? bits.join(", ") : undefined, failures };
  },
};

// `bun script.ts` - a crash, not a test run. Bun stamps its own version at the foot of
// one, which nothing else writes, so that is what identifies the tool:
//
//   2 |   charge() { throw new Error("payment gateway unreachable"); }
//                            ^
//   error: payment gateway unreachable
//         at charge (/abs/bthrow.ts:2:24)
//         at /abs/bthrow.ts:4:15
//
//   Bun v1.3.14 (macOS arm64)
//
// Without this the node parser claimed it - the frames are node-shaped enough - and a
// `bun` command was reported as having failed under node.
const BUN_FOOTER = /^Bun v[\d.]+[^\S\n]+\(/m;
// bun writes the class for a thrown builtin and a bare "error:" for its own diagnostics.
const RUNTIME_ERR_RE = /^(?:(\w*(?:Error|Exception)): |error: )(.+)$/;
// Frames come both ways: named with parentheses, and bare when there is no function.
const RUNTIME_AT_RE = /^[^\S\n]+at[^\S\n]+(?:(.+?)[^\S\n]+\()?(.+?):(\d+):(\d+)\)?[^\S\n]*$/;
const RUNTIME_SRC_RE = /^[^\S\n]*(\d+)[^\S\n]*\|[^\S\n]?(.*)$/;

export const bunRuntime = {
  name: "bun",
  category: "runtime",
  commands: ["bun", "bunx"],
  detect: (s) => BUN_FOOTER.test(s) && !/^\(fail\)[^\S\n]+/m.test(s),

  extract(s) {
    const lines = s.split("\n");
    // A crash is one message, and it ends at the footer. "error: <anything>" belongs to
    // half the tools in existence - cargo writes it, deno writes it - so scanning the
    // whole log for one meant that with the footer present this parser claimed every
    // such line in a log holding more than one tool. It did so 120 times.
    //
    // Walking back from the footer finds it: blank lines and frames first, then the
    // message. Stopping AT the message rather than treating it as one more thing a
    // crash is made of matters - cargo ends a build with "error: could not compile ...",
    // and with that line directly above bun's block the walk went straight past bun's
    // own message and took cargo's.
    const foot = lines.findIndex((l) => /^Bun v[\d.]+[^\S\n]+\(/.test(l));
    if (foot < 0) return null;

    let at = foot - 1;
    while (at >= 0 && (!lines[at].trim() || RUNTIME_AT_RE.test(lines[at]))) at--;
    const m = at >= 0 ? lines[at].match(RUNTIME_ERR_RE) : null;
    if (!m) return null;

    const frames = [];
    for (let j = at + 1; j < foot; j++) {
      const f = lines[j].match(RUNTIME_AT_RE);
      if (!f) { if (frames.length) break; else continue; }
      frames.push({ fn: f[1] ?? "<anonymous>", file: unfile(f[2]), line: +f[3], col: +f[4] });
    }
    const user = frames.filter((f) => !isNoise(f.file));
    const where = user[0] ?? frames[0];

    // The echoed source sits directly above the message, numbered, with a caret under
    // the column. Only those two shapes, so the walk cannot reach into another tool.
    let stmt;
    if (where) {
      for (let j = at - 1; j >= 0 && j >= at - 8; j--) {
        if (!RUNTIME_SRC_RE.test(lines[j]) && !CARET_RE.test(lines[j])) break;
        const src = lines[j].match(RUNTIME_SRC_RE);
        if (src && +src[1] === where.line) { stmt = src[2].trim(); break; }
      }
    }

    const failures = [{
      file: where?.file, line: where?.line, col: where?.col,
      // A thrown builtin names its class, which is the searchable handle. bun's own
      // diagnostics write a bare "error:" - a constant it prints for a whole class of
      // failure, which is what `label` is for, and the two are alternatives.
      title: m[1] ?? "error", code: m[1], label: m[1] ? undefined : "error",
      severity: "error", message: m[2], stmt,
      trace: user.slice(0, 4).map((f) => `${f.fn} (${f.file}:${f.line}:${f.col})`),
      hiddenFrames: frames.length - user.length,
    }];
    if (!failures.length) return null;
    return { tool: "bun", failures };
  },
};
