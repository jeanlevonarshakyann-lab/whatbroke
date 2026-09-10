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

export default {
  name: "docker",
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

  extract(s) {
    const lines = s.split("\n");
    let file, line, stmt, step, final, relayed;
    for (let i = 0; i < lines.length; i++) {
      // A location is only docker's if the fenced excerpt follows it, which is also what
      // keeps `foo.py:3` from somewhere else in the log being read as one.
      const at = lines[i].match(LOC);
      if (at && FENCE.test(lines[i + 1] ?? "")) {
        file = at[1]; line = +at[2];
        for (let j = i + 2; j < lines.length && !FENCE.test(lines[j]); j++) {
          const p = lines[j].match(POINTED);
          if (p) stmt = p[1];
        }
        continue;
      }
      const st = lines[i].match(STEP_ERROR);
      // BuildKit repeats each step's error at the end, prefixed. Keeping the first
      // real one and ignoring the restatement is what stops the doubled report.
      if (st) {
        if (!RELAYED.test(st[2])) step ??= st[2];
        else if (!relayed && !printedOutput(lines, st[1])) relayed = st[2];
        continue;
      }
      const fin = lines[i].match(FINAL_ERROR);
      if (fin && !RELAYED.test(fin[1])) final ??= fin[1];
    }
    const message = step ?? final ?? relayed;
    if (!message) return null;
    return {
      tool: "docker",
      summary: "1 error",
      failures: [{
        ...(file ? { file, line } : {}),
        title: "build failed", label: "build failed", severity: "error",
        message, ...(stmt ? { stmt } : {}),
      }],
    };
  },
};
