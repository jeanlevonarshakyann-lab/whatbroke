import { isNoise } from "../util.js";
import { withSource } from "../ownership.js";

const CHAIN = /^(?:During handling of the above exception|The above exception was the direct cause)/;
const HEADER = /^Traceback \(most recent call last\):$/;

const FRAME_RE = /^[^\S\n]*File "(.+?)", line (\d+), in (.+)$/;
// `python -m pytest` with pytest not installed prints one line and stops: the
// interpreter's own path, then what it could not find. No traceback, no "Error", no
// location - and it is the entire log of a CI step that never ran a test at all. The
// interpreter at the start is what tells it from a traceback's "ModuleNotFoundError: No
// module named 'x'", which is quoted, already read, and has a stack above it.
const NO_MODULE_RE = /^(\S*python[\d.]*(?:\.exe)?):[^\S\n]+No module named[^\S\n]+(\S+)[^\S\n]*$/m;
const errorLine = (line) => {
  const l = line.trim();
  return !!l && !/^File "/.test(l) && !/^\^+$/.test(l) && !/^~*\^+~*$/.test(l) &&
    (/^\w[\w.]*(Error|Exception|Warning)\b/.test(l) || /^\w[\w.]*: /.test(l));
};

/**
 * What every traceback in `lines` says: where it is, its deepest frame and its error.
 *
 * A traceback ends at its unindented exception line. Slicing to the end of the log
 * instead meant that in a log holding more than one tool the exception came from the
 * other one: the error is found searching backwards for "Name: message", and node --test
 * prints "code: 'ERR_TEST_FAILURE'", which is exactly that shape.
 *
 * Chained tracebacks ("During handling of the above exception...") are one block, and
 * the last exception in the chain is the one that was actually raised, so the scan
 * steps over the notice rather than stopping at the exception line before it. A header
 * inside a block is stepped over the same way - which is what made reading each block
 * from its own header quadratic: a log repeating the header with no exception under any
 * of them read to the end of the log once per header, and parsed all of it each time.
 * Where a block ends, and the last error and frames before any line, are the same
 * questions for every header, so they are answered once, from the end of the log.
 */
function tracebackReadings(lines) {
  const n = lines.length;
  const headers = [];
  for (let i = 0; i < n; i++) if (HEADER.test(lines[i])) headers.push(i);
  if (!headers.length) return [];
  // stops[i]: the line a scan from i ends its block on (n if it runs out), once a scan
  // has passed i. A scan's path depends only on where it is, so every position it passes
  // shares its answer, and no position is walked twice.
  const stops = new Int32Array(n + 1).fill(-1);
  stops[n] = n;
  const stopFrom = (from) => {
    const path = [];
    let i = from, stop = n;
    while (i < n) {
      if (stops[i] !== -1) { stop = stops[i]; break; }
      path.push(i);
      const l = lines[i];
      if (!l.trim() || /^[^\S\n]/.test(l) || CHAIN.test(l) || HEADER.test(l)) { i++; continue; }
      let j = i + 1;
      while (j < n && !lines[j].trim()) j++;
      if (j < n && CHAIN.test(lines[j])) { i = j + 1; continue; }
      stop = i;
      break;
    }
    for (const at of path) stops[at] = stop;
    return stop;
  };
  const ends = headers.map((start) => {
    const stop = stopFrom(start + 1);
    return stop < n ? stop + 1 : n;
  });
  // The last error line, frame and frame in your code before each block's end, read
  // backwards from the end once for all the blocks sharing it. Blocks that end apart
  // never overlap, so no line is read twice here either.
  const earliest = new Map();
  headers.forEach((start, k) => { if (!earliest.has(ends[k]) || earliest.get(ends[k]) > start) earliest.set(ends[k], start); });
  const last = new Map();
  for (const [end, from] of earliest) {
    let error = -1, frame = -1, own = -1;
    for (let k = end - 1; k > from && (error === -1 || own === -1); k--) {
      if (error === -1 && errorLine(lines[k])) error = k;
      if (own !== -1) continue;
      const m = lines[k].match(FRAME_RE);
      if (!m) continue;
      if (frame === -1) frame = k;
      if (!isNoise(m[1])) own = k;
    }
    last.set(end, { error, frame, own });
  }
  return headers.map((start, k) => {
    const end = ends[k];
    const { error, frame, own } = last.get(end);
    const at = own > start ? own : frame > start ? frame : -1;
    const m = at === -1 ? null : lines[at].match(FRAME_RE);
    // Read from the header to the error, or to the frame and its source line when the
    // error is not there - not to wherever the block's scan ran out.
    const read = Math.max(error > start ? error : start, at === -1 ? start : at + 1 < end ? at + 1 : at);
    return {
      start, end: read + 1,
      deepest: m ? { file: m[1], line: +m[2], fn: m[3], code: at + 1 < end ? lines[at + 1].trim() : "" } : undefined,
      err: error > start ? lines[error].trim() : "",
    };
  });
}

/** Parse one "Traceback (most recent call last):" block into frames + final error. */
function parseTraceback(body) {
  const frames = [];
  for (let i = 0; i < body.length; i++) {
    const m = body[i].match(/^[^\S\n]*File "(.+?)", line (\d+), in (.+)$/);
    if (m) frames.push({ file: m[1], line: +m[2], fn: m[3], code: (body[i + 1] ?? "").trim() });
  }
  let err = "";
  for (let i = body.length - 1; i >= 0; i--) {
    const l = body[i].trim();
    if (l && !/^File "/.test(l) && !/^\^+$/.test(l) && !/^~*\^+~*$/.test(l)) {
      if (/^\w[\w.]*(Error|Exception|Warning)\b/.test(l) || /^\w[\w.]*: /.test(l)) { err = l; break; }
    }
  }
  const user = frames.filter((f) => !isNoise(f.file));
  return { frames, deepest: (user.length ? user : frames).at(-1), err };
}

// A file that will not compile never runs, so there is no traceback and no frames -
// just where the parser gave up:
//
//   File "syn.py", line 1
//       def f(:
//             ^
//   SyntaxError: invalid syntax
//
// That location line is a traceback frame's shape WITHOUT the ", in <name>" a frame
// always carries, which is what tells the two apart. It is one of the commonest ways a
// Python run fails, and it was reaching the guess.
const COMPILE_AT_RE = /^[^\S\n]*File "(.+?)", line (\d+)[^\S\n]*$/;
const COMPILE_ERR_RE = /^(\w*(?:SyntaxError|IndentationError|TabError)):[^\S\n]*(.*)$/;
const CARET_RE = /^[^\S\n]*\^+[^\S\n]*$/;

/** The compile error in this log, if it holds one and no traceback. */
function compileError(lines) {
  for (let i = 0; i < lines.length; i++) {
    const at = lines[i].match(COMPILE_AT_RE);
    if (!at) continue;
    let stmt;
    for (let j = i + 1; j < lines.length && j <= i + 4; j++) {
      const err = lines[j].match(COMPILE_ERR_RE);
      if (err) {
        // The location, the source and caret under it, and the error.
        return withSource({
          file: at[1], line: +at[2],
          title: err[1], code: err[1], severity: "error",
          message: err[2].trim() || err[1], stmt,
        }, i, j + 1);
      }
      if (lines[j].trim() && !CARET_RE.test(lines[j]) && !stmt) stmt = lines[j].trim();
    }
  }
  return null;
}

export const traceback = {
  name: "python",
  // Strings a log has to hold for this parser to read anything from it - see src/router.js.
  signals: ["Traceback (most recent call last):", "SyntaxError", "IndentationError", "TabError", "No module named"],
  category: "runtime",
  commands: ["python", "python3"],
  detect: (s) => /^Traceback \(most recent call last\):$/m.test(s) ||
    NO_MODULE_RE.test(s) || !!compileError(s.split("\n")),
  extract(s) {
    const lines = s.split("\n");
    const failures = [];
    let unittestFallback = null;
    for (const { start, end, deepest, err } of tracebackReadings(lines)) {
      // unittest owns tracebacks framed by its FAIL/ERROR header. The generic Python
      // parser must still keep scanning: a standalone traceback may follow the test
      // summary in a mixed CI log.
      const framedByUnittest = /^(?:FAIL|ERROR): /.test(lines[start - 2] ?? "") &&
        /^-{10,}$/.test(lines[start - 1] ?? "");
      if (!deepest && !err) continue;
      const failure = withSource({
        file: deepest?.file, line: deepest?.line,
        title: deepest?.fn ?? "traceback", subject: deepest?.fn, severity: "error",
        message: err, stmt: deepest?.code,
      }, start, end);
      if (framedByUnittest) unittestFallback ??= failure;
      else failures.push(failure);
    }
    // Preserve the detector matrix's historical losing-parser probe on a pure
    // unittest log. When independent Python output exists, only that output belongs
    // to this parser.
    if (!failures.length && unittestFallback) failures.push(unittestFallback);
    // A compile error stands beside any tracebacks rather than instead of them. As a
    // fallback it went missing the moment a log held both - a CI job that ran one suite
    // to a traceback and another to a syntax error reported only the first.
    const compiled = compileError(lines);
    if (compiled && !failures.some((f) => f.file === compiled.file && f.line === compiled.line)) {
      failures.push(compiled);
    }
    // The interpreter refusing to start is a failure with no location at all, and stands
    // beside anything else in the log rather than instead of it.
    lines.forEach((line, i) => {
      const missing = line.match(NO_MODULE_RE);
      if (!missing) return;
      failures.push(withSource({
        title: missing[2], subject: missing[2], severity: "error",
        message: `No module named ${missing[2]}`,
      }, i, i + 1));
    });
    if (!failures.length) return null;
    return { tool: "python", failures };
  },
};

export const unittest = {
  name: "unittest",
  // Strings a log has to hold for this parser to read anything from it - see src/router.js.
  signals: ["Ran "],
  category: "test",
  commands: ["python", "python3"],
  detect: (s) => /^Ran \d+ tests? in /m.test(s) && /^(FAIL|ERROR): /m.test(s),
  extract(s) {
    const lines = s.split("\n");
    const failures = [];
    for (let i = 0; i < lines.length; i++) {
      const h = lines[i].match(/^(FAIL|ERROR): (\S+)/);
      if (!h) continue;
      // "ERROR: <something>" at line start belongs to half the tools in existence -
      // pip writes "ERROR: Invalid requirement: ...". unittest's header sits inside a
      // frame: a row of "=" above it and a row of "-" below, every time. Without that
      // the parser read pip's line as a test named "Invalid".
      if (!/^={10,}$/.test(lines[i - 1] ?? "") || !/^-{10,}$/.test(lines[i + 1] ?? "")) continue;
      const body = [];
      let j = i + 2;
      for (; j < lines.length && !/^={10,}$/.test(lines[j]) && !/^-{10,}$/.test(lines[j]); j++)
        body.push(lines[j]);
      const { deepest, err } = parseTraceback(body);
      // The header in its frame of rules, and the traceback under it.
      while (j > i + 2 && !lines[j - 1].trim()) j--;
      failures.push(withSource({
        file: deepest?.file, line: deepest?.line,
        title: h[2], subject: h[2], severity: "error", message: err || h[1], stmt: deepest?.code,
      }, i - 1, j));
    }
    let summary;
    const ran = lines.find((l) => /^Ran \d+ tests? in /.test(l));
    const verdict = lines.find((l) => /^(OK|FAILED)\b/.test(l));
    if (ran) summary = [ran, verdict].filter(Boolean).join("  ");
    if (!failures.length) return null;
    return { tool: "unittest", summary, failures };
  },
};
