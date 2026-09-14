// swiftc writes clang's diagnostic shape - "file:line:col: severity: message" - and then
// draws the source underneath it: numbered echo lines, and an annotation hanging off the
// column that repeats the message word for word. Only the header is the diagnostic.
//
//   mixed.swift:10:14: error: cannot convert value of type 'String' to specified type 'Int'
//    9 |
//   10 | let x: Int = "hello"
//      |              `- error: cannot convert value of type 'String' to specified type 'Int'
import { joinSources, withSource } from "../ownership.js";

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

const swiftText = {
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
    const seen = new Map();

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      const driver = line.match(DRIVER_RE);
      if (driver) {
        // swiftc doubles the word when the driver speaks: "error: error opening input
        // file 'x' (No such file or directory)". The second one is the message.
        failures.push(withSource({
          title: driver[1], label: driver[1], severity: "error",
          message: driver[2].replace(/^error:[^\S\n]+/, ""),
        }, i, i + 1));
        continue;
      }

      // The annotation under the caret repeats the header verbatim. Reading it as a
      // second diagnostic doubled every count.
      if (GUTTER_RE.test(line)) continue;

      const m = line.match(DIAGNOSTIC_RE);
      if (!m) continue;
      // The detector may see a .swift diagnostic elsewhere in a mixed build. The
      // clang-shaped line being extracted still has to be Swift's own source.
      if (!/\.swift$/.test(m[1])) continue;
      const severity = m[4];
      // The pattern admits "note" because it is clang's diagnostic shape, and clang does
      // write standalone notes. swiftc 6 does not: it draws them inside the gutter
      // annotation, where GUTTER_RE has already skipped them. The guard stays because
      // the pattern would otherwise report one as a failure - it is not reached by any
      // capture on this compiler, and a conformance error, which is the case that
      // produces the most notes, is in the corpus to show they do not leak in.
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
      // The diagnostic and the source it draws in the gutter under it.
      let end = i + 1;
      while (end < lines.length && end <= i + 12 && GUTTER_RE.test(lines[end])) end++;

      // swiftc reports the same diagnostic once per compilation job, so a file built for
      // several targets says it several times - each one a place it was read.
      const key = `${m[1]}:${m[2]}:${m[3]}:${message}`;
      if (seen.has(key)) { failures[seen.get(key)] = joinSources(failures[seen.get(key)], withSource({}, i, end)); continue; }
      seen.set(key, failures.length);

      failures.push(withSource({
        file: m[1], line: +m[2], col: +m[3],
        title: group ? group[1] : "compile error",
        // A failure has to say what it is or clustering cannot group it: eight identical
        // "cannot convert value of type 'String'" errors were listed one by one, with
        // four of them behind a "... 4 more". The group tag is a diagnostic identifier
        // when swiftc gives one; when it does not, "error" is the constant it prints for
        // the whole class, which is what `label` is for. The two are alternatives.
        code: group ? group[1] : undefined,
        label: group ? undefined : "error",
        severity: "error", message, stmt,
      }, i, end));
    }

    if (!failures.length) return null;
    const n = failures.length;
    const summary = `${n} error${n === 1 ? "" : "s"}${warnings ? `, ${warnings} warning${warnings === 1 ? "" : "s"}` : ""}`;
    return { tool: "swift", summary, failures };
  },
};

/** Records from swiftc's length-prefixed `-parseable-output` stream.
 *
 * The decimal length is bytes, not JavaScript characters. Reading through Buffer is
 * therefore required for a diagnostic containing a non-ASCII source line. Ordinary
 * chatter can sit between records in a combined CI log and is skipped line by line. */
// JSON's whitespace, as bytes.
const JSON_SPACE = new Set([0x20, 0x09, 0x0a, 0x0d]);

function parseableRecords(text) {
  const bytes = Buffer.from(text, "utf8");
  const records = [];
  let offset = 0;
  let line = 0;
  // A header claims how many bytes follow it, and each claim was decoded and parsed to
  // find out whether it was a record: a log whose every line is a number claiming the
  // rest of the log decoded the rest of the log once per line. A record is an object, so
  // a body that does not open with `{` and close with `}` is not decoded at all, and the
  // bytes spent on bodies that are not records are capped at a few times the log -
  // swiftc's own records parse, so they never come near it.
  let refused = 0;
  const REFUSED_LIMIT = bytes.length * 4;
  while (offset < bytes.length) {
    const newline = bytes.indexOf(10, offset);
    if (newline < 0) break;
    const header = bytes.subarray(offset, newline).toString("utf8").trim();
    if (!/^\d+$/.test(header)) { offset = newline + 1; line++; continue; }
    const length = Number(header);
    const bodyStart = newline + 1;
    const bodyEnd = bodyStart + length;
    if (!Number.isSafeInteger(length) || length <= 0 || bodyEnd > bytes.length) {
      offset = newline + 1; line++;
      continue;
    }
    if (refused > REFUSED_LIMIT) { offset = newline + 1; line++; continue; }
    let first = bodyStart, last = bodyEnd - 1;
    while (first < bodyEnd && JSON_SPACE.has(bytes[first])) first++;
    while (last > first && JSON_SPACE.has(bytes[last])) last--;
    // Whitespace walked past to find the braces is charged too: many headers could claim
    // bodies that end inside one long run of blank lines.
    refused += (first - bodyStart) + (bodyEnd - 1 - last);
    if (bytes[first] !== 0x7b || bytes[last] !== 0x7d) {
      offset = newline + 1; line++;
      continue;
    }
    let value;
    try { value = JSON.parse(bytes.subarray(bodyStart, bodyEnd).toString("utf8")); }
    catch { refused += length; offset = newline + 1; line++; continue; }
    if (value && typeof value === "object" && typeof value.kind === "string" &&
        typeof value.name === "string") {
      const newlines = bytes.subarray(offset, bodyEnd).reduce((n, byte) => n + (byte === 10), 0);
      records.push({ value, start: line, end: line + newlines + 1 });
      line += newlines;
      offset = bodyEnd;
    } else {
      offset = newline + 1; line++;
    }
  }
  return records;
}

const swiftMachineRecords = (text) => parseableRecords(text).filter(({ value }) =>
  value.name === "compile" && typeof value.output === "string" &&
  /^.+\.swift:\d+:\d+:[^\S\n]+(?:error|warning|note):/m.test(value.output));

export default {
  ...swiftText,

  detect: (text) => swiftMachineRecords(text).length > 0 || swiftText.detect(text),

  extract(text) {
    const records = swiftMachineRecords(text);
    if (!records.length) return swiftText.extract(text);
    // The output field is the exact human diagnostic swiftc would otherwise print.
    // Reusing that parser keeps source gutters, warning policy, codes and de-duplication
    // identical across the two modes.
    const result = swiftText.extract(records.map(({ value }) => value.output).join("\n"));
    if (!result?.failures?.length) return null;
    const failures = result.failures.map((failure) => {
      const location = failure.file && failure.line && failure.col
        ? `${failure.file}:${failure.line}:${failure.col}:` : null;
      const owner = records.find(({ value }) => !location || value.output.includes(location));
      // Read from the record whose output holds it, not from the joined text.
      const copy = { ...failure };
      return owner ? withSource(copy, owner.start, owner.end) : copy;
    });
    return { ...result, failures };
  },
};
