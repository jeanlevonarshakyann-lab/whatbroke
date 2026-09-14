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
import { throughOrigin } from "../ownership.js";

const EVENT = /^[^\S\n]*\{.*"Action"[^\S\n]*:.*\}[^\S\n]*$/;

/** The verbose log a test2json stream was made from, and the line of the stream each of
 *  its lines came from - or null if this is not one. */
function rebuild(s) {
  let events = 0;
  const out = s.split("\n").map((line) => {
    if (!EVENT.test(line)) return line;
    let e;
    try { e = JSON.parse(line); } catch { return line; }
    if (typeof e?.Action !== "string") return line;
    events++;
    // A package that will not compile reports its errors as "build-output", not "output"
    // - and keeping only "output" lost a compile error without a word, so a stream with a
    // package that never built read as though every package had.
    return (e.Action === "output" || e.Action === "build-output") && typeof e.Output === "string"
      ? e.Output.replace(/\r?\n$/, "") : "";
  });
  if (!events) return null;
  // An event's output is one line as a rule; one that holds a line break becomes more.
  const origin = [];
  out.forEach((line, i) => {
    origin.push(i);
    if (line.includes("\n")) for (let k = line.split("\n").length - 1; k > 0; k--) origin.push(i);
  });
  return { text: out.join("\n"), origin };
}

export default {
  name: "go test -json",
  // Strings a log has to hold for this parser to read anything from it - see src/router.js.
  signals: ["\"Action\""],
  category: "test",
  commands: ["gotestsum"],

  detect: (s) => rebuild(s) !== null,

  extract(s) {
    const rebuilt = rebuild(s);
    const result = rebuilt === null ? null : gotest.extract(rebuilt.text);
    if (!result) return null;
    // go's parser says where in the rebuilt log; the events are where in this one.
    return { ...result, failures: result.failures.map((f) => throughOrigin(f, rebuilt.origin)) };
  },
};
