import { findJsonDocument } from "../util.js";
const LOCATION_RE = /^[^\S\n]+#[^\S\n]+(.+):(\d+):in\b/;
// A spec file that raises while being loaded never becomes a numbered example, so it is
// reported as prose above the tally instead - and the tally then says "0 examples, 0
// failures, 1 error occurred outside of examples", which is not a failure count the
// numbered form would ever produce.
const LOAD_ERROR_RE = /^An error occurred while loading (.+?)\.$/;
// -f json is the same run as one document: every example with its full description, the
// file and line it was declared at, and the exception it raised. Nothing read it, so a
// run that failed three examples came back with no diagnosis at all.
//
// It carries one thing less than the text form, and one thing more. Less: the
// `Failure/Error:` line, which quotes the source of the failing example - that is
// written by the text reporters and is nowhere in the document. More: the exception's
// class for every failure, where the text form prints it only when the exception is not
// an expectation that went unmet.
const REPORT = (v) => !!v && typeof v === "object" && Array.isArray(v.examples) &&
  v.examples.length > 0 && v.examples.every((e) => e && typeof e.full_description === "string" &&
    typeof e.status === "string" && typeof e.file_path === "string");
const report = (s) => s.includes('"full_description"') ? findJsonDocument(s, REPORT) : null;
// rspec wraps an expectation failure's message in blank lines and indents nothing.
const EXPECTATION = /^RSpec::Expectations::/;

export default {
  name: "rspec",
  category: "test",
  commands: ["rspec", "bundle"],
  detect: (s) =>
    report(s) !== null ||
    (/^[^\S\n]+\d+\) /m.test(s) &&
      (/Finished in .+ seconds?/m.test(s) || /^\d+ examples?, \d+ failures?/m.test(s))) ||
    (LOAD_ERROR_RE.test(s.split("\n").find((l) => LOAD_ERROR_RE.test(l)) ?? "") &&
      /^\d+ examples?, \d+ failures?/m.test(s)),

  extract(s) {
    const lines = s.split("\n");
    const failures = [];
    for (let i = 0; i < lines.length; i++) {
      const load = lines[i].match(LOAD_ERROR_RE);
      if (load) {
        let file = load[1], line, message = [];
        for (let j = i + 1; j < lines.length && !/^No examples found\.|^Finished in /.test(lines[j]); j++) {
          const at = lines[j].match(/^#[^\S\n]+(.+?):(\d+):in\b/) ?? lines[j].match(LOCATION_RE);
          if (at) { file = at[1]; line = +at[2]; continue; }
          if (lines[j].trim()) message.push(lines[j].trim());
        }
        failures.push({
          file, line, title: "load error", label: "load error", severity: "error",
          message: message.join("\n").replace(/^Failure\/Error:[^\S\n]*/, ""),
        });
        continue;
      }
      const header = lines[i].match(/^[^\S\n]+\d+\)[^\S\n]+(.+)$/);
      if (!header) continue;
      let message = [];
      let file;
      let line;
      const body = [];
      // Every line of a numbered example is indented or blank; the block ends at the
      // first line at column zero. The named terminators below are rspec's own, so in a
      // log holding another tool they sat far past the end of the block - Playwright
      // numbers its failures the same way, and its last one ran on into an rspec report
      // pasted under it and took the "Failure/Error:" line that proves ownership.
      for (let j = i + 1; j < lines.length &&
        (!lines[j].trim() || /^[^\S\n]/.test(lines[j])) &&
        !/^[^\S\n]+\d+\)[^\S\n]+/.test(lines[j]) &&
        !/^Finished in /.test(lines[j]) &&
        !/^Top \d+ slowest/.test(lines[j]) &&
        !/^Failed examples:/.test(lines[j]); j++) body.push(lines[j]);
      // "  1) name" is not rspec's alone: Playwright numbers its failures exactly the
      // same way, and the terminators above are rspec's own, so in a log holding both
      // this block ran on past Playwright's failure and swallowed its assertion text.
      // Under a numbered example rspec always writes either "Failure/Error:" or a
      // "# ./file:N:in" backtrace line; Playwright writes neither.
      if (!body.some((l) => /^[^\S\n]*Failure\/Error:/.test(l) || LOCATION_RE.test(l))) continue;
      for (const l of body) {
        const location = l.match(LOCATION_RE);
        if (location) { file = location[1]; line = +location[2]; }
        if (l.trim() && !/^[^\S\n]+# /.test(l)) message.push(l.trim());
      }
      failures.push({
        file, line, title: header[1], subject: header[1], severity: "error",
        message: message.join("\n").replace(/^Failure\/Error:[^\S\n]*/, ""),
      });
    }
    // ...and the same run as `-f json` wrote it. A log can hold both - rspec can be
    // asked for two formatters at once, one to the console and one to a file - and an
    // example already read is not read twice.
    const doc = report(s);
    const said = new Set(failures.map((f) => [f.subject, f.file, f.line].join("\u0000")));
    let pending = 0;
    for (const e of doc?.examples ?? []) {
      if (e.status !== "failed") { if (e.status === "pending") pending++; continue; }
      // The document says where the example was declared; the text form points at the
      // line that raised. The backtrace's first frame is that line, and it is the one
      // both formats agree on.
      const frame = String(e.exception?.backtrace?.[0] ?? "").match(/^(.+?):(\d+):in\b/);
      const file = frame ? frame[1] : e.file_path;
      const line = frame ? +frame[2] : e.line_number;
      const key = [e.full_description, file, line].join("\u0000");
      if (said.has(key)) continue;
      said.add(key);
      // An expectation that went unmet is reported by its message alone, exactly as the
      // text form reports it; anything else is named by its class first, also as the
      // text form does.
      const cls = String(e.exception?.class ?? "");
      const body = String(e.exception?.message ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
      failures.push({
        file, line, title: e.full_description, subject: e.full_description, severity: "error",
        message: (EXPECTATION.test(cls) || !cls ? body : [`${cls}:`, ...body]).join("\n"),
      });
    }

    if (!failures.length) return null;
    // rspec writes "1 failure" and "2 failures"; rebuilding the sentence from the
    // numbers lost that and always said "failures"
    // "0 examples, 0 failures" is what rspec's tally starts with when a spec file failed
    // to load, and stopping there turns a real failure into a headline that reads like
    // success. The clause that says what happened comes after it.
    const summaryMatch = s.match(/\d+ examples?, \d+ failures?(?:, \d+ pending)?(?:, \d+ errors? occurred outside of examples)?/);
    // The document has no sentence of its own, so one is written from what it counted.
    const counted = doc && !summaryMatch
      ? `${doc.examples.length} example${doc.examples.length === 1 ? "" : "s"}, ` +
        `${failures.length} failure${failures.length === 1 ? "" : "s"}` +
        (pending ? `, ${pending} pending` : "")
      : null;
    return {
      tool: "rspec",
      summary: summaryMatch ? summaryMatch[0] : counted ?? `${failures.length} failures`,
      failures,
    };
  },
};
