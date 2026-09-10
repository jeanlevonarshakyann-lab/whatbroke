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

export const traceback = {
  name: "python",
  category: "runtime",
  commands: ["python", "python3"],
  detect: (s) => /^Traceback \(most recent call last\):$/m.test(s),
  extract(s) {
    const lines = s.split("\n");
    const start = lines.findIndex((l) => HEADER.test(l));
    if (start < 0) return null;
    const { deepest, err } = parseTraceback(tracebackBody(lines, start));
    if (!deepest && !err) return null;
    return {
      tool: "python",
      failures: [{
        file: deepest?.file, line: deepest?.line,
        title: deepest?.fn ?? "traceback", subject: deepest?.fn, severity: "error",
        message: err, stmt: deepest?.code,
      }],
    };
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
