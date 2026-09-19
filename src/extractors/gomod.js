// `go mod tidy`, `go mod download` and every build that has to resolve modules first
// report through go's module loader, which writes neither a location on its own line nor
// any of the words a failure is usually found by. Two shapes, and both read as nothing:
//
//   go: errors parsing go.mod:
//   go.mod:12: unknown directive: nonsense
//
//   go: shop/internal/store imports
//       github.com/nonexistent/gone: module lookup disabled by GOPROXY=off
//
// The first is a file and a line and is read as such. The second is a chain: what the
// module graph was following when it gave up, ending in the module it could not get and
// why. The module is the subject, the reason is the message, and the path that led there
// is the trace - because "which of my imports pulled this in" is the whole question when a
// dependency cannot be resolved.
//
// What is NOT read is a bare `go: <sentence>` on its own - `go: invalid GOTOOLCHAIN ...`
// and the like. `go: downloading ...` and `go: finding ...` are the same shape and are
// progress, not failure, and nothing in the line says which it is.
import { counted } from "../util.js";
import { withSource } from "../ownership.js";

const PARSE_HEAD_RE = /^go:[^\S\n]+errors parsing[^\S\n]+(\S+):[^\S\n]*$/;
// The loader writes the path it was given, which is `go.mod` from the module root and an
// absolute path from anywhere else.
const PARSE_LINE_RE = /^(\S*go\.mod):(\d+):[^\S\n]*(\S.*?)[^\S\n]*$/;
const IMPORTS_HEAD_RE = /^go:[^\S\n]+(\S+)[^\S\n]+imports[^\S\n]*$/;
// `go mod download` names the module and the version it wanted, with no chain above it.
// The "@" is what separates this from `go: downloading <module> <version>`, which is
// progress and carries neither an "@" nor a colon.
const AT_VERSION_RE = /^go:[^\S\n]+(\S+@\S+?):[^\S\n]*(\S.*?)[^\S\n]*$/;
// Each further link is indented; the last one names the module and says why, with a colon
// the earlier links do not have.
const LINK_RE = /^[^\S\n]+(\S+)[^\S\n]+imports[^\S\n]*$/;
const REASON_RE = /^[^\S\n]+(\S+?):[^\S\n]*(\S.*?)[^\S\n]*$/;

const chainAt = (lines, i) => {
  const head = lines[i].match(IMPORTS_HEAD_RE);
  if (!head) return null;
  const path = [head[1]];
  let j = i + 1;
  for (; j < lines.length; j++) {
    const link = lines[j].match(LINK_RE);
    if (!link) break;
    path.push(link[1]);
  }
  const reason = j < lines.length && lines[j].match(REASON_RE);
  return reason ? { path, module: reason[1], why: reason[2], end: j + 1 } : null;
};

export default {
  name: "go mod",
  // Strings a log has to hold for this parser to read anything from it - see src/router.js.
  signals: ["go: "],
  category: "build",
  commands: ["go"],

  detect: (s) => {
    const lines = s.split("\n");
    return lines.some((line, i) =>
      PARSE_HEAD_RE.test(line) || AT_VERSION_RE.test(line) || chainAt(lines, i) !== null);
  },

  extract(s) {
    const lines = s.split("\n");
    const failures = [];
    let parsed = 0, unresolved = 0;
    for (let i = 0; i < lines.length; i++) {
      if (PARSE_HEAD_RE.test(lines[i])) {
        // Every go.mod line under the banner, to the first line that is not one.
        for (let j = i + 1; j < lines.length; j++) {
          const at = lines[j].match(PARSE_LINE_RE);
          if (!at) break;
          parsed++;
          // A short label for the class of failure, the way cmake's syntax errors carry
          // "cmake error": every rendered location line has to carry one, or the GitHub
          // problem matcher reads nothing from it and CI annotates the diff with nothing.
          failures.push(withSource({
            file: at[1], line: +at[2],
            title: "go.mod", label: "go.mod", severity: "error",
            message: at[3],
          }, i, j + 1));
          i = j;
        }
        continue;
      }
      const at = lines[i].match(AT_VERSION_RE);
      if (at) {
        unresolved++;
        failures.push(withSource({
          title: at[1], subject: at[1], severity: "error", message: at[2],
        }, i, i + 1));
        continue;
      }
      const chain = chainAt(lines, i);
      if (!chain) continue;
      unresolved++;
      failures.push(withSource({
        // No file: the failure is about a module, and the go.mod line that requires it is
        // not what go printed. Saying where it is not is better than saying where it is not.
        title: chain.module, subject: chain.module, severity: "error",
        message: chain.why,
        // The convention every trace here follows: the first entry repeats the failure's
        // own location, and the rest are what led to it. go prints the chain outermost
        // first; nearest first is the order a reader wants, because the import they can
        // do something about is theirs, and theirs is the near end.
        trace: [chain.module, ...[...chain.path].reverse()].slice(0, 5),
        hiddenFrames: chain.path.length > 4 ? chain.path.length - 4 : undefined,
      }, i, chain.end));
      i = chain.end - 1;
    }
    if (!failures.length) return null;
    // go prints no tally of its own, so the headline says which kind of problem it was.
    const summary = parsed && !unresolved ? `${counted(parsed, "error")} parsing go.mod`
      : unresolved && !parsed ? `${counted(unresolved, "module")} could not be resolved`
      : counted(failures.length, "problem");
    return { tool: "go mod", summary, failures };
  },
};
