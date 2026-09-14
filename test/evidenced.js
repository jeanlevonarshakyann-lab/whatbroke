// Shared by test/evidence.js, which holds each parser's ranges to the text it was given,
// and test/report.js, which holds each report's evidence to the output it came from.
//
// What a range has to hold to be about its failure: the file's name, the code, the name of
// the test, or the start or end of a line of the message - as written, or as JSON or XML
// would have escaped it. A test's result line often says nothing but its name, and a line
// said twice can differ in front: PHP writes a fatal to its error log as `PHP Parse
// error:  ...` and to stdout as `Parse error: ...`.
export function evidenced(failure, lines, { start, end }) {
  const said = lines.slice(start, end).join("\n").replace(/[^\S\n]+/g, " ");
  const forms = (value) => {
    const v = String(value);
    return [v, JSON.stringify(v).slice(1, -1),
      v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;"),
      v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")];
  };
  const holds = (value) => !!value && forms(value).some((form) => said.includes(form));
  const base = failure.file ? String(failure.file).split(/[\\/]/).pop() : null;
  // A place can hold a later line of the message rather than its first: go's test prints
  // each of its messages on a line of its own, and parallel tests interleave them.
  const messageLines = String(failure.message ?? "").split("\n").map((l) => l.trim().replace(/[^\S\n]+/g, " "));
  const starts = messageLines.flatMap((l) => [l.slice(0, 16), l.slice(-16)]).filter((l) => l.length >= 6);
  const names = [failure.subject, failure.title].map((v) => String(v ?? "").trim()).filter((v) => v.length >= 4);
  // A message too short to search for - the generic reader's `FAIL` - has to be a whole
  // line of the range.
  const whole = String(failure.message ?? "").split("\n").map((l) => l.trim()).filter((l) => l && l.length < 6);
  const lineIs = (text) => lines.slice(start, end).some((l) => l.trim() === text);
  return holds(base) || holds(failure.code) || starts.some(holds) || names.some(holds) || whole.some(lineIs);
}
