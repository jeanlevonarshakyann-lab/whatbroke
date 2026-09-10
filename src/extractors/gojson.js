// `go test -json` is a stream of test2json events, one JSON object per line, and it is
// what gotestsum and most Go CI tooling keep. Nothing here could read a word of it: four
// real failures came back as a single guess made of raw JSON.
//
// It needs no parser of its own. Every "output" event carries a line of what go would
// have printed in verbose mode, so replacing each event with that line - and every other
// event with an empty one - rebuilds the verbose log line for line, and go's own parser
// reads it with everything it already knows about subtests, parallel tests, panics and
// data races. That reading of verbose output is what made this possible: until go's
// parser attributed a verbose line to the test named in the frame above it, the
// rebuilt log was read as wrongly as `go test -v` itself.
//
// The rebuilding happens inside the parser, not as a rewrite of the log, so each
// failure's private source range is still located in the JSON that was actually given.
import gotest from "./gotest.js";

const EVENT = /^[^\S\n]*\{.*"Action"[^\S\n]*:.*\}[^\S\n]*$/;

/** The verbose log a test2json stream was made from, or null if this is not one. */
function rebuild(s) {
  let events = 0;
  const out = s.split("\n").map((line) => {
    if (!EVENT.test(line)) return line;
    let e;
    try { e = JSON.parse(line); } catch { return line; }
    if (typeof e?.Action !== "string") return line;
    events++;
    return e.Action === "output" && typeof e.Output === "string" ? e.Output.replace(/\r?\n$/, "") : "";
  });
  return events ? out.join("\n") : null;
}

export default {
  name: "go test -json",
  category: "test",
  commands: ["gotestsum"],

  detect: (s) => rebuild(s) !== null,

  extract(s) {
    const text = rebuild(s);
    return text === null ? null : gotest.extract(text);
  },
};
