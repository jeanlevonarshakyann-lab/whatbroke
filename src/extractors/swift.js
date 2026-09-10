// swiftc writes clang's diagnostic shape - "file:line:col: severity: message" - and then
// draws the source underneath it: numbered echo lines, and an annotation hanging off the
// column that repeats the message word for word. Only the header is the diagnostic.
//
//   mixed.swift:10:14: error: cannot convert value of type 'String' to specified type 'Int'
//    9 |
//   10 | let x: Int = "hello"
//      |              `- error: cannot convert value of type 'String' to specified type 'Int'
const DIAGNOSTIC_RE = /^(.+?):(\d+):(\d+):[^\S\n]+(error|warning|note):[^\S\n]+(.+)$/;
// Newer swiftc tags a diagnostic with the group it belongs to, which is what you would
// silence or search for: "... was never used ... [#no-usage]".
const GROUP_RE = /[^\S\n]+\[#([\w-]+)\]$/;
// The compiler speaks for itself when there is no source to point at - a missing input,
// a bad flag - and writes a placeholder location rather than none at all.
const DRIVER_RE = /^<unknown>:0:[^\S\n]+(error|fatal error):[^\S\n]+(.+)$/;
// The echoed source, and the annotation drawn under it. Both start with the gutter.
const GUTTER_RE = /^[^\S\n]*\d*[^\S\n]*\|/;
const SOURCE_RE = /^[^\S\n]*(\d+)[^\S\n]*\|[^\S\n]?(.*)$/;

export default {
  name: "swift",
  category: "compile",
  commands: ["swift", "swiftc", "xcrun"],

  // The diagnostic shape alone is clang's too, so it has to be corroborated by something
  // only Swift writes: a .swift file, the driver's placeholder location, or SwiftPM's
  // own wording.
  detect: (s) =>
    (/^.+:\d+:\d+:[^\S\n]+(?:error|warning|note):[^\S\n]+/m.test(s) &&
      /\.swift\b/.test(s)) ||
    DRIVER_RE.test(s.split("\n").find((l) => DRIVER_RE.test(l)) ?? "") ||
    /^error: (?:fatalError|terminated\(\d+\)|Compiling for .+ but module)/m.test(s),

  extract(s) {
    const lines = s.split("\n");
    const failures = [];
    let warnings = 0;
    const seen = new Set();

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      const driver = line.match(DRIVER_RE);
      if (driver) {
        // swiftc doubles the word when the driver speaks: "error: error opening input
        // file 'x' (No such file or directory)". The second one is the message.
        failures.push({
          title: driver[1], label: driver[1], severity: "error",
          message: driver[2].replace(/^error:[^\S\n]+/, ""),
        });
        continue;
      }

      // The annotation under the caret repeats the header verbatim. Reading it as a
      // second diagnostic doubled every count.
      if (GUTTER_RE.test(line)) continue;

      const m = line.match(DIAGNOSTIC_RE);
      if (!m) continue;
      const severity = m[4];
      if (severity === "note") continue;
      if (severity === "warning") { warnings++; continue; }

      let message = m[5];
      const group = message.match(GROUP_RE);
      if (group) message = message.slice(0, group.index);

      // The echoed source line carries the code the diagnostic is about. It is the one
      // whose gutter number matches the diagnostic's own line.
      let stmt;
      for (let j = i + 1; j < lines.length && j <= i + 8 && GUTTER_RE.test(lines[j]); j++) {
        const src = lines[j].match(SOURCE_RE);
        if (src && +src[1] === +m[2]) { stmt = src[2].trim(); break; }
      }

      // swiftc reports the same diagnostic once per compilation job, so a file built for
      // several targets says it several times.
      const key = `${m[1]}:${m[2]}:${m[3]}:${message}`;
      if (seen.has(key)) continue;
      seen.add(key);

      failures.push({
        file: m[1], line: +m[2], col: +m[3],
        title: group ? group[1] : "compile error",
        code: group ? group[1] : undefined,
        severity: "error", message, stmt,
      });
    }

    if (!failures.length) return null;
    const n = failures.length;
    const summary = `${n} error${n === 1 ? "" : "s"}${warnings ? `, ${warnings} warning${warnings === 1 ? "" : "s"}` : ""}`;
    return { tool: "swift", summary, failures };
  },
};
