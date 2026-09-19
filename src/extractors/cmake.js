// CMake reports a configure failure with the script and line, the command that raised
// it, and an indented block of prose below:
//
//   CMake Error at CMakeLists.txt:3 (add_executable):
//     Cannot find source file:
//
//       missing_source.c
//
// Nothing in that shape looks like a compiler diagnostic, so a configure failure - a
// missing source, a package that will not be found, a parse error in the script itself -
// produced no diagnosis at all.
//
// ninja deliberately has no parser: what fails under it is a compiler, and that already
// has one. Its own "FAILED: [code=1] <object>" line restates the failure without adding
// to it, exactly as make's exit line does. make does have a parser, but only for the
// failures make itself raises - see src/extractors/make.js for where that line is drawn.
import { withSource } from "../ownership.js";

const HEAD_RE = /^CMake (Error|Warning|Deprecation Warning)(?:[^\S\n]+at[^\S\n]+(.+?):(\d+)(?:[^\S\n]+\(([^)]+)\))?)?:[^\S\n]*$/;
// cmake refusing before it reads any script: a source directory that is not there, one
// with no CMakeLists.txt in it, a generator it does not have. The message sits on the
// banner's own line and there is no location, because nothing has been read yet - so the
// pattern above, which ends at the colon, matches none of it and the whole log, which is
// usually that one line, went unread.
const FLAT_RE = /^CMake (Error|Warning):[^\S\n]+(\S.*?)[^\S\n]*$/;
// Everything from here down is the run reporting that it gave up.
const TAIL_RE = /^(?:--[^\S\n]|CMake Generate step failed|Configuring incomplete)/;
const MAX_MESSAGE = 4;

export default {
  name: "cmake",
  // Strings a log has to hold for this parser to read anything from it - see src/router.js.
  signals: ["CMake "],
  category: "build",
  commands: ["cmake", "ctest"],

  detect: (s) => s.split("\n").some((l) => HEAD_RE.test(l) || FLAT_RE.test(l)),

  extract(s) {
    const lines = s.split("\n");
    const failures = [];
    let warnings = 0;
    for (let i = 0; i < lines.length; i++) {
      const flat = lines[i].match(FLAT_RE);
      if (flat) {
        if (flat[1] !== "Error") { warnings++; continue; }
        failures.push(withSource({
          title: "cmake error", label: "cmake error", severity: "error", message: flat[2],
        }, i, i + 1));
        continue;
      }
      const h = lines[i].match(HEAD_RE);
      if (!h) continue;
      const message = [];
      // The heading and the indented prose under it.
      let end = i + 1;
      for (let j = i + 1; j < lines.length && message.length < MAX_MESSAGE; j++) {
        if (HEAD_RE.test(lines[j]) || TAIL_RE.test(lines[j])) break;
        // the block is indented; an unindented line has left it
        if (lines[j].trim() && !/^[^\S\n]/.test(lines[j])) break;
        if (lines[j].trim()) { message.push(lines[j].trim()); end = j + 1; }
      }
      if (h[1] !== "Error") { warnings++; continue; }
      failures.push(withSource({
        file: h[2], line: h[3] ? +h[3] : undefined,
        // The command that raised it - add_executable, find_package - is the closest
        // thing CMake gives to a code, and is what you would search for.
        title: h[4] ?? "cmake error", ...(h[4] ? { code: h[4] } : { label: "cmake error" }),
        severity: "error", message: message.join("\n"),
      }, i, end));
    }
    if (!failures.length) return null;
    const n = failures.length;
    return {
      tool: "cmake",
      summary: `${n} error${n > 1 ? "s" : ""}` +
        (warnings ? ` — ${warnings} warning${warnings > 1 ? "s" : ""} hidden` : ""),
      failures,
    };
  },
};
