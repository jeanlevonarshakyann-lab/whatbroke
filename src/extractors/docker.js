// Docker's own build failures - a Dockerfile it cannot parse, a base image it cannot
// pull, a COPY whose source is not there. These carry a location, and BuildKit prints it
// in a shape nothing here read:
//
//   Dockerfile:2
//   --------------------
//      1 |     FROM debian:stable-slim
//      2 | >>> COPY missing-file.txt /tmp/
//      3 |
//   --------------------
//   ERROR: failed to build: failed to solve: ... "/missing-file.txt": not found
//
// The fallback scraped the ERROR lines and reported the failure twice, because BuildKit
// says it once per step and again at the end, and used neither the file nor the line.
//
// `process "/bin/sh -c pytest -q" did not complete successfully: exit code: 1` is docker
// relaying an inner command's exit status, and whatever ran inside said it better - the
// same thing make's `Error N` does. Usually that means declining, and those logs stay
// with the tool that actually failed: docker_buildkit_pytest_fail is still pytest's.
//
// Usually, but not always. `RUN exit 3` fails without printing anything, and then the
// relayed line is the only account of the failure that exists - declining left the
// fallback to scrape docker's two ERROR lines as two failures and drop the location.
// BuildKit says which case it is, so this does not have to be guessed at: it tags every
// line a step printed with that step's own number and elapsed time. A failing step with
// no such line said nothing, and docker's account of it is the only one there is.
import { alsoFrom, withSource } from "../ownership.js";

const LOC = /^(\S+):(\d+)[^\S\n]*$/;
const FENCE = /^-{5,}[^\S\n]*$/;
// `   2 | >>> COPY missing-file.txt /tmp/` - BuildKit marks the offending line itself.
const POINTED = /^[^\S\n]*\d+[^\S\n]*\|[^\S\n]*>>>[^\S\n]?(.*?)[^\S\n]*$/;
const STEP_ERROR = /^#(\d+)[^\S\n]+ERROR:[^\S\n]+(.+?)[^\S\n]*$/;
const FINAL_ERROR = /^ERROR:[^\S\n]+(?:failed to build:[^\S\n]+)?failed to solve:[^\S\n]+(.+?)[^\S\n]*$/;
// docker saying that the command it ran exited non-zero. The command said why.
const RELAYED = /^process[^\S\n]+".*"[^\S\n]+did not complete successfully:[^\S\n]+exit code:[^\S\n]*\d+[^\S\n]*$/;

/** Did this build step print anything of its own? BuildKit tags a step's output with
 *  the step number and the elapsed time - `#9 0.211 FF.` - and nothing else it writes
 *  about a step takes that shape. */
function printedOutput(lines, step) {
  const re = new RegExp(`^#${step}[^\\S\\n]+\\d+\\.\\d+[^\\S\\n]`);
  return lines.some((l) => re.test(l));
}

// BuildKit ends a failed build by quoting the failing step's own output between two
// rules, which is the only place that output appears without its `#5 0.070 ` tag:
//
//   ------
//    > [2/2] RUN nosuchcommand --help:
//   0.070 /bin/sh: nosuchcommand: not found
//   ------
//
// Read from here rather than from the tagged lines, because the tags do not always
// survive: a log that arrived with a stray carriage return in it has the per-line shape
// stripped off before any parser sees it, and `#5 ERROR:` becomes `ERROR:`. The quoted
// block comes through either way, and normalize.js already describes it as the cause
// verbatim from whatever tool actually failed.
const QUOTED_STEP = /^[^\S\n]*>[^\S\n]*\[\d+\/\d+\][^\S\n]*(.*):[^\S\n]*$/;
const STAMP = /^\d+\.\d+[^\S\n]/;

/** What the failing step said for itself, and the line it was read from. When the command
 *  inside is not a tool anything here knows, this is the only account of the failure that
 *  exists - the relayed line names the command and its exit code, and neither says why. */
function quotedCause(lines) {
  const head = lines.findIndex((l) => QUOTED_STEP.test(l));
  if (head < 0) return null;
  let last = null;
  for (let i = head + 1; i < lines.length && !FENCE.test(lines[i]); i++) {
    const text = lines[i].replace(STAMP, "").trim();
    if (text) last = { text, at: i };
  }
  return last;
}

export default {
  name: "docker",
  // Strings a log has to hold for this parser to read anything from it - see src/router.js.
  signals: ["ERROR:"],
  category: "build",
  commands: ["docker", "buildx", "podman"],

  // An ERROR line is not enough to claim the log: the one BuildKit writes for a step
  // whose command exited non-zero is on every log of a failed `RUN`, and this parser
  // will not read those. Claim only what it can actually answer.
  detect(s) {
    const lines = s.split("\n");
    return lines.some((l) => {
      const st = l.match(STEP_ERROR);
      if (st) return !RELAYED.test(st[2]) || !printedOutput(lines, st[1]);
      const fin = l.match(FINAL_ERROR);
      return !!fin && !RELAYED.test(fin[1]);
    });
  },

  // Asked only once src/index.js has established that no parser read this log. `detect`
  // above turns down a relayed failure whose step printed something, because that
  // something is usually a tool's own diagnostic and better than anything docker can
  // say. When it is `/bin/sh: nosuchcommand: not found`, no parser reads it, and docker
  // is the only thing in the log that knows which Dockerfile line was running.
  lastResort(s) {
    const lines = s.split("\n");
    const relayed = lines.some((l) => {
      const st = l.match(STEP_ERROR);
      if (st) return RELAYED.test(st[2]);
      const fin = l.match(FINAL_ERROR);
      return !!fin && RELAYED.test(fin[1]);
    });
    return relayed && !!quotedCause(lines);
  },

  extract(s) {
    const lines = s.split("\n");
    let file, line, stmt, step, final, relayed, excerpt, said;
    // Where each part was read: the step's error, docker's closing one, the relayed exit.
    let stepAt, finalAt, relayedAt, saidAt;
    for (let i = 0; i < lines.length; i++) {
      // A location is only docker's if the fenced excerpt follows it, which is also what
      // keeps `foo.py:3` from somewhere else in the log being read as one.
      const at = lines[i].match(LOC);
      if (at && FENCE.test(lines[i + 1] ?? "")) {
        file = at[1]; line = +at[2];
        let j = i + 2;
        for (; j < lines.length && !FENCE.test(lines[j]); j++) {
          const p = lines[j].match(POINTED);
          if (p) stmt = p[1];
        }
        excerpt = [i, Math.min(j, lines.length - 1) + 1];
        continue;
      }
      const st = lines[i].match(STEP_ERROR);
      // BuildKit repeats each step's error at the end, prefixed. Keeping the first
      // real one and ignoring the restatement is what stops the doubled report.
      if (st) {
        if (!RELAYED.test(st[2])) { if (step === undefined) { step = st[2]; stepAt = i; } }
        else if (!relayed && !printedOutput(lines, st[1])) { relayed = st[2]; relayedAt = i; }
        continue;
      }
      const fin = lines[i].match(FINAL_ERROR);
      if (fin && !RELAYED.test(fin[1]) && final === undefined) { final = fin[1]; finalAt = i; }
    }
    // Last: the failing step's own words, for a relayed failure nothing else explained.
    // Its last line is the cause; the ones above it are progress.
    const spoke = (step ?? final ?? relayed) === undefined ? quotedCause(lines) : null;
    if (spoke) { said = spoke.text; saidAt = spoke.at; }
    const message = step ?? final ?? relayed ?? said;
    if (!message) return null;
    // The line the message was read from, and the fenced excerpt that located it.
    const from = step !== undefined ? stepAt
      : final !== undefined ? finalAt
      : relayed !== undefined ? relayedAt : saidAt;
    const failure = withSource({
      ...(file ? { file, line } : {}),
      title: "build failed", label: "build failed", severity: "error",
      message, ...(stmt ? { stmt } : {}),
    }, from, from + 1);
    return {
      tool: "docker",
      summary: "1 error",
      failures: [excerpt ? alsoFrom(failure, ...excerpt) : failure],
    };
  },
};
