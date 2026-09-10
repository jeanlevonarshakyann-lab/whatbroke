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
// What this parser will not read is `process "/bin/sh -c pytest -q" did not complete
// successfully: exit code: 1`. That is docker relaying an inner command's exit status,
// and whatever ran inside said it better - exactly as make's `Error N` does, and the
// same rule applies: a consequence is not a failure. Those logs stay with the tool that
// actually failed, which is why docker_buildkit_pytest_fail is still owned by pytest.
const LOC = /^(\S+):(\d+)[^\S\n]*$/;
const FENCE = /^-{5,}[^\S\n]*$/;
// `   2 | >>> COPY missing-file.txt /tmp/` - BuildKit marks the offending line itself.
const POINTED = /^[^\S\n]*\d+[^\S\n]*\|[^\S\n]*>>>[^\S\n]?(.*?)[^\S\n]*$/;
const STEP_ERROR = /^#\d+[^\S\n]+ERROR:[^\S\n]+(.+?)[^\S\n]*$/;
const FINAL_ERROR = /^ERROR:[^\S\n]+(?:failed to build:[^\S\n]+)?failed to solve:[^\S\n]+(.+?)[^\S\n]*$/;
// docker saying that the command it ran exited non-zero. The command said why.
const RELAYED = /^process[^\S\n]+".*"[^\S\n]+did not complete successfully:[^\S\n]+exit code:[^\S\n]*\d+[^\S\n]*$/;

export default {
  name: "docker",
  category: "build",
  commands: ["docker", "buildx", "podman"],

  // An ERROR line is not enough to claim the log: the one BuildKit writes for a step
  // whose command exited non-zero is on every log of a failed `RUN`, and this parser
  // will not read those. Claim only what it can actually answer.
  detect: (s) => s.split("\n").some((l) => {
    const m = l.match(STEP_ERROR) ?? l.match(FINAL_ERROR);
    return !!m && !RELAYED.test(m[1]);
  }),

  extract(s) {
    const lines = s.split("\n");
    let file, line, stmt, step, final;
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
      if (st && !RELAYED.test(st[1])) { step ??= st[1]; continue; }
      const fin = lines[i].match(FINAL_ERROR);
      if (fin && !RELAYED.test(fin[1])) final ??= fin[1];
    }
    const message = step ?? final;
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
