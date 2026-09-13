// `mocha --reporter json` - what a pipeline uses when something downstream reads the
// result. Mocha pretty-prints it across forty-odd lines, so unlike eslint's or jest's
// single-line reports it cannot be found by scanning for a line that parses. Nothing
// here could read a word of it, and a real failing run came back with no diagnosis.
//
// The document is found by its own shape rather than by position: an object carrying
// `stats` with a failure count, and a `failures` array. A log can hold other JSON.
import { isNoise, jsonDocuments } from "../util.js";

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

// Every report in the log, not the first: two runs' reports in one log read as one run,
// and the second run's failures went unreported.
function mochaReports(text) {
  if (!MARKER.test(text)) return [];
  return [...jsonDocuments(text, (v) => v && typeof v === "object" && !Array.isArray(v) &&
    v.stats && Array.isArray(v.failures) && typeof v.stats.failures === "number")];
}

// --reporter json-stream writes the run as it happens, one event a line:
//
//   ["fail",{"title":"totals an invoice","fullTitle":"cart totals an invoice","file":"/app/test/cart.test.js",
//            "err":"Expected values to be strictly equal:\n\n4 !== 6\n","stack":"AssertionError ..."}]
//   ["end",{"suites":1,"tests":3,"passes":1,"pending":0,"failures":2, ...}]
//
// Nothing read it. Each failure carries the same fields as a record in the json report,
// with the message as a string of its own beside the stack rather than inside `err`.
const STREAM_RE = /^\["(fail|end)",\{.*\}\][^\S\n]*$/;

function streamed(text) {
  if (!text.includes('["fail",')) return null;
  const failures = [];
  let end = null;
  for (const line of text.split("\n")) {
    const m = line.match(STREAM_RE);
    if (!m) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const body = event[1];
    if (m[1] === "end") { end = body; continue; }
    if (typeof body?.fullTitle !== "string") continue;
    failures.push({ ...body, err: { message: typeof body.err === "string" ? body.err : body.err?.message, stack: body.stack } });
  }
  return failures.length ? { failures, stats: end } : null;
}

export default {
  name: "mocha json",
  category: "test",
  commands: ["mocha"],

  detect: (s) => mochaReports(s).length > 0 || !!streamed(s),

  extract(s) {
    const reports = [...mochaReports(s), streamed(s)].filter(Boolean);
    const failed = reports.flatMap((r) => r.failures);
    if (!failed.length) return null;
    const failures = failed.map((test) => {
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
    const passed = reports.reduce((n, r) => n + (Number.isInteger(r.stats?.passes) ? r.stats.passes : 0), 0);
    return {
      tool: "mocha",
      summary: `${failures.length} failing, ${passed} passing`,
      failures,
    };
  },
};
