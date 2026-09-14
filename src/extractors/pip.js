import { traceback } from "./python.js";
import { joinSources, withSource } from "../ownership.js";

// pip states a failure two or three times. A build error is printed once inside the
// subprocess's own output block, then repeated at the end as "See above for output",
// and both are followed by a note explaining that it is not pip's fault. A resolution
// error arrives as "Could not find a version…" and again as "No matching distribution
// found for…". None of that is a second failure.
const NOTICE = /^\[notice\]/;
const SUBPROCESS_NOTE = /^[^\S\n]*note: This error originates from a subprocess/;
const IGNORED = /^ERROR: Ignored the following/;
// "(from versions: 1.3.0, 1.4.1, … 300 more)" is the whole index, not the diagnosis.
const VERSION_LIST = /[^\S\n]*\(from versions:[^)]*\)/;

// A build runner reporting that a step exited non-zero, rather than any tool's finding.
const RUNNER_MECHANISM = /failed to solve:|did not complete successfully/;

const OUTPUT_START = /^[^\S\n]*╰─>[^\S\n]*\[\d+ lines of output\]/;
const OUTPUT_END = /^[^\S\n]*\[end of output\]/;

/** Strip the common indentation pip adds when it quotes a subprocess. */
function dedent(lines) {
  const width = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^[^\S\n]*/)[0].length));
  return lines.map((l) => l.slice(width)).join("\n");
}

/** The build subprocess prints its own diagnostics, and for a Python build that is a
 *  traceback - so hand it to the parser that already knows which frames are yours and
 *  which belong to setuptools. */
function fromOutputBlock(lines, at) {
  const block = [];
  let i = at + 1;
  for (; i < lines.length && !OUTPUT_END.test(lines[i]); i++) block.push(lines[i]);
  if (!block.length) return null;
  // The block runs to its `[end of output]`, or to the end of the log without one.
  const end = Math.min(i, lines.length - 1) + 1;
  const inner = dedent(block);
  if (traceback.detect(inner)) {
    const r = traceback.extract(inner);
    // The traceback's own range is in the block, not in the log.
    if (r?.failures?.length) return { failure: { ...r.failures[0] }, end };
  }
  // Not a traceback: the last line that says something is the closest thing to a cause.
  const last = block.map((l) => l.trim()).filter(Boolean).at(-1);
  return last ? { failure: { message: last }, end } : null;
}

const requirementOf = (s) => s.match(/^Processing (\S+)/m)?.[1]
  ?? s.match(/^[^\S\n]*Building wheel for (\S+)/m)?.[1]
  ?? s.match(/^Collecting (\S+)/m)?.[1];

export default {
  name: "pip",
  // Strings a log has to hold for this parser to read anything from it - see src/router.js.
  signals: ["Could not find a version that satisfies", "No matching distribution found", "Could not open requirements file", "Invalid requirement:", "subprocess-exited-with-error", "ResolutionImpossible", "Getting requirements to build wheel", "A new release of pip"],
  category: "package",
  commands: ["pip", "pip3", "uv", "poetry"],
  // uv and Poetry may merely launch the tool that owns the useful diagnostic.
  commandHints: ["pip", "pip3"],

  // `ERROR: ` alone belongs to half a dozen tools, so it has to be corroborated by
  // something only pip prints.
  detect: (s) =>
    (/^ERROR: /m.test(s) || /^[^\S\n]*error: subprocess-exited-with-error/m.test(s)) &&
    /(Could not find a version that satisfies|No matching distribution found|Could not open requirements file|Invalid requirement:|subprocess-exited-with-error|ResolutionImpossible|Getting requirements to build wheel|^\[notice\] A new release of pip)/m.test(s),

  extract(s) {
    const lines = s.split("\n");
    const failures = [];
    const said = new Map();      // one diagnosis, however many times pip prints it
    const push = (f, start, end) => {
      // Keyed on the requirement and the kind of problem, not the wording: pip says
      // "Could not find a version that satisfies X" and then "No matching distribution
      // found for X", which is one failure described twice - read in both places.
      const key = f.subject ? `${f.subject}|${f.title ?? ""}` : String(f.message ?? "").slice(0, 200);
      if (said.has(key)) { failures[said.get(key)] = joinSources(failures[said.get(key)], withSource({}, start, end)); return; }
      said.set(key, failures.length);
      // The traceback parser echoes the failing source line, and for a bare raise that
      // line IS the message. Printing it twice explains nothing.
      const stmt = f.stmt && f.stmt.trim() !== String(f.message ?? "").trim() ? f.stmt : undefined;
      failures.push(withSource({ severity: "error", ...f, stmt }, start, end));
    };

    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (NOTICE.test(l) || SUBPROCESS_NOTE.test(l) || IGNORED.test(l)) continue;

      if (OUTPUT_START.test(l)) {
        const inner = fromOutputBlock(lines, i);
        if (inner) {
          // Keep the traceback's file, line and message - that is the actual cause -
          // but not its title, which is the enclosing function name and here is
          // "<module>". What failed is the package pip was building.
          push({ ...inner.failure, subject: requirementOf(s), label: undefined, title: "build failed" }, i, inner.end);
        }
        continue;
      }

      // pip echoes the offending requirement under the error and puts the location on
      // the caret line, not on the message:
      //
      //   ERROR: Invalid requirement: 'requests==': Expected end or semicolon
      //       requests==
      //               ^ (from line 1 of bad.txt)
      const bad = l.match(/^ERROR: Invalid requirement: '([^']*)': (.+?)(?:[^\S\n]*\(from line (\d+) of (.+?)\))?[^\S\n]*$/);
      if (bad) {
        let file = bad[4];
        let line = bad[3] ? +bad[3] : undefined;
        let stmt, end = i + 1;
        for (let j = i + 1; j < lines.length && j <= i + 3; j++) {
          const from = lines[j].match(/\(from line (\d+) of (.+?)\)[^\S\n]*$/);
          if (from) { line = +from[1]; file = from[2]; end = j + 1; break; }
          if (lines[j].trim() && !/^[^\S\n]*\^/.test(lines[j]) && stmt === undefined) { stmt = lines[j].trim(); end = j + 1; }
        }
        push({ file, line, subject: bad[1], title: "invalid requirement", message: bad[2], stmt }, i, end);
        continue;
      }

      const noFile = l.match(/^ERROR: Could not open requirements file: (.+)$/);
      if (noFile) { push({ subject: noFile[1].match(/'([^']+)'/)?.[1], title: "requirements file", message: noFile[1] }, i, i + 1); continue; }

      const noVersion = l.match(/^ERROR: Could not find a version that satisfies the requirement (\S+)/);
      if (noVersion) { push({ subject: noVersion[1], title: "no matching distribution", message: l.slice("ERROR: ".length).replace(VERSION_LIST, "") }, i, i + 1); continue; }

      // The second wording of the same failure; keep it only if the first never came.
      const noDist = l.match(/^ERROR: No matching distribution found for (\S+)/);
      if (noDist) { push({ subject: noDist[1], title: "no matching distribution", message: l.slice("ERROR: ".length) }, i, i + 1); continue; }

      const conflict = l.match(/^ERROR: Cannot install (.+?) because these package versions have conflicting dependencies/);
      if (conflict) { push({ subject: conflict[1], title: "conflicting dependencies", message: l.slice("ERROR: ".length) }, i, i + 1); continue; }

      const other = l.match(/^ERROR: (.+)$/);
      // The catch-all is the weakest rule here, and in a container it reaches a line
      // that is not pip's at all: Docker ends a failed build with `ERROR: failed to
      // build: failed to solve: process ... did not complete successfully`. That is the
      // runner saying the step exited non-zero, which is the mechanism and never the
      // diagnosis - and pip installs inside a Dockerfile are not a rare arrangement.
      if (other && !RUNNER_MECHANISM.test(other[1])) {
        push({ title: "error", label: "error", message: other[1].replace(VERSION_LIST, "") }, i, i + 1);
      }
    }

    if (!failures.length) return null;
    return { tool: "pip", summary: `${failures.length} error${failures.length > 1 ? "s" : ""}`, failures };
  },
};
