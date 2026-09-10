import { isNoise } from "../util.js";

const CHAIN = /^(?:During handling of the above exception|The above exception was the direct cause)/;
const HEADER = /^Traceback \(most recent call last\):$/;

/**
 * The lines belonging to the traceback that starts at `start` - and no further.
 *
 * A traceback ends at its unindented exception line. Slicing to the end of the log
 * instead meant that in a log holding more than one tool the exception came from the
 * other one: parseTraceback searches backwards for "Name: message", and node --test
 * prints "code: 'ERR_TEST_FAILURE'", which is exactly that shape.
 *
 * Chained tracebacks ("During handling of the above exception...") are one block, and
 * the last exception in the chain is the one that was actually raised, so the scan
 * steps over the notice rather than stopping at the exception line before it.
 */
function tracebackBody(lines, start) {
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim() || /^[^\S\n]/.test(l)) continue;
    if (CHAIN.test(l) || HEADER.test(l)) continue;
    let j = i + 1;
    while (j < lines.length && !lines[j].trim()) j++;
    if (j < lines.length && CHAIN.test(lines[j])) { i = j; continue; }
    end = i + 1;
    break;
  }
  return lines.slice(start + 1, end);
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
        return {
          file: at[1], line: +at[2],
          title: err[1], code: err[1], severity: "error",
          message: err[2].trim() || err[1], stmt,
        };
      }
      if (lines[j].trim() && !CARET_RE.test(lines[j]) && !stmt) stmt = lines[j].trim();
    }
  }
  return null;
}

export const traceback = {
  name: "python",
  category: "runtime",
  commands: ["python", "python3"],
  detect: (s) => /^Traceback \(most recent call last\):$/m.test(s) ||
    !!compileError(s.split("\n")),
  extract(s) {
    const lines = s.split("\n");
    const failures = [];
    let unittestFallback = null;
    for (let start = 0; start < lines.length; start++) {
      if (!HEADER.test(lines[start])) continue;
      // unittest owns tracebacks framed by its FAIL/ERROR header. The generic Python
      // parser must still keep scanning: a standalone traceback may follow the test
      // summary in a mixed CI log.
      const framedByUnittest = /^(?:FAIL|ERROR): /.test(lines[start - 2] ?? "") &&
        /^-{10,}$/.test(lines[start - 1] ?? "");
      const { deepest, err } = parseTraceback(tracebackBody(lines, start));
      if (!deepest && !err) continue;
      const failure = {
        file: deepest?.file, line: deepest?.line,
        title: deepest?.fn ?? "traceback", subject: deepest?.fn, severity: "error",
        message: err, stmt: deepest?.code,
      };
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
    if (!failures.length) return null;
    return { tool: "python", failures };
  },
};

export const unittest = {
  name: "unittest",
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
      for (let j = i + 2; j < lines.length && !/^={10,}$/.test(lines[j]) && !/^-{10,}$/.test(lines[j]); j++)
        body.push(lines[j]);
      const { deepest, err } = parseTraceback(body);
      failures.push({
        file: deepest?.file, line: deepest?.line,
        title: h[2], subject: h[2], severity: "error", message: err || h[1], stmt: deepest?.code,
      });
    }
    let summary;
    const ran = lines.find((l) => /^Ran \d+ tests? in /.test(l));
    const verdict = lines.find((l) => /^(OK|FAILED)\b/.test(l));
    if (ran) summary = [ran, verdict].filter(Boolean).join("  ");
    if (!failures.length) return null;
    return { tool: "unittest", summary, failures };
  },
};
