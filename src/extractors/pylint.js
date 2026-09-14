import { findJsonDocument, jsonDocumentsAt } from "../util.js";
import { joinSources, withSource } from "../ownership.js";
// pylint heads each module it checked and then lists its findings, with the symbolic
// name of the check in parentheses at the end:
//
//   ************* Module lint_me
//   lint_me.py:1:0: C0114: Missing module docstring (missing-module-docstring)
//   lint_me.py:3:4: W0612: Unused variable 'unused' (unused-variable)
//
//   Your code has been rated at 2.00/10
//
// The symbolic name is what you would put in a disable comment, and it is what pylint's
// own documentation is indexed by - more useful than C0114 on its own, so both are kept:
// the code identifies, the name explains.
// The filename is whatever was on the command line, and a directory with a space in it
// is ordinary on macOS and Windows: pylint prints `my project/mod.py:4:11: E0602: ...`
// and a pattern written (\S+?) matched none of it, so the whole run came back silent.
// What bounds the name is not its own shape but the message code that follows it - a
// letter and four digits is not something a path runs into by accident.
const FINDING_RE = /^(.+?):(\d+):(\d+):[^\S\n]+([CRWEF]\d{4}):[^\S\n]+(.+?)(?:[^\S\n]+\(([\w-]+)\))?[^\S\n]*$/;
// -f parseable and -f msvs print the same findings with the code and the symbolic name
// moved into a bracket, and no column at all. The bracket also carries the enclosing
// class or function, and the two formats attach it differently: parseable writes
// `[E1101(no-member), Basket.total]` and keeps the comma even when there is nothing
// after it, msvs writes `[E1101(no-member)Basket.total]` with no comma at all. Reading
// the comma as the separator worked on every finding at module level and dropped every
// finding inside a class - so whatever follows the symbolic name is skipped instead.
// The two otherwise differ only in how the line is attached: `mod.py:1:` against
// `mod.py(1):`.
const BRACKET = "\\[([CRWEF]\\d{4})\\(([\\w-]+)\\)[^\\]]*\\]";
const PARSEABLE_RE = new RegExp(`^(.+?):(\\d+):[^\\S\\n]+${BRACKET}[^\\S\\n]+(.+?)[^\\S\\n]*$`);
const MSVS_RE = new RegExp(`^(.+?)\\((\\d+)\\):[^\\S\\n]+${BRACKET}[^\\S\\n]+(.+?)[^\\S\\n]*$`);
const MODULE_RE = /^\*{3,}[^\S\n]+Module[^\S\n]+\S+/m;
const RATING_RE = /^Your code has been rated at/m;
// C and R are convention and refactor suggestions; W is a warning. E and F stop the run.
const STOPS_THE_RUN = /^[EF]/;

// -f json is an array of messages; -f json2 wraps the same messages in an object beside
// the run's statistics, and renames one key. Both are pretty-printed across many lines,
// so neither can be found by looking for a line that parses.
const isMessage = (r) => r && typeof r.path === "string" && Number.isInteger(r.line) &&
  typeof (r["message-id"] ?? r.messageId) === "string" && typeof r.symbol === "string";
const JSON_MARK = (v) => {
  const list = Array.isArray(v) ? v : Array.isArray(v?.messages) ? v.messages : null;
  return !!list && list.length > 0 && list.every(isMessage);
};
const jsonMessages = (s) => {
  const v = findJsonDocument(s, JSON_MARK);
  return v === null ? [] : Array.isArray(v) ? v : v.messages;
};

export default {
  name: "pylint",
  // Strings a log has to hold for this parser to read anything from it - see src/router.js.
  signals: ["*** Module", "Your code has been rated at", "\"symbol\""],
  category: "lint",
  commands: ["pylint"],

  // flake8 writes the same location shape without a colon after its code, so the colon
  // is what tells them apart - and pylint's module banner confirms it. The banner is
  // printed by every text format, but the JSON ones print nothing but the document.
  detect: (s) => MODULE_RE.test(s) || RATING_RE.test(s) || jsonMessages(s).length > 0,

  extract(s) {
    // Collect first, decide after. Only E and F stop a run; C, R and W are convention,
    // refactor and warning. But pylint exits non-zero on those alone, so a run that
    // found nothing but conventions still failed and still has to say why - reporting
    // none of them would be reporting nothing.
    const all = [];
    const seen = new Map();
    const add = (f) => {
      // One log can hold the same run printed more than one way, and the formats differ
      // over whether a column was printed at all - so the column is not part of what
      // makes a finding distinct. Where it was read the second time is kept.
      const key = [f.file, f.line, f.code].join("\u0000");
      if (seen.has(key)) { all[seen.get(key)] = joinSources(all[seen.get(key)], f); return; }
      seen.set(key, all.length);
      all.push(f);
    };
    const lines = s.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(FINDING_RE);
      if (m) {
        add(withSource({ file: m[1], line: +m[2], col: +m[3], title: m[6] ?? m[4], code: m[4],
          severity: "error", message: m[5].trim() }, i, i + 1));
        continue;
      }
      const b = lines[i].match(PARSEABLE_RE) ?? lines[i].match(MSVS_RE);
      if (b) {
        add(withSource({ file: b[1], line: +b[2], title: b[4], code: b[3],
          severity: "error", message: b[5].trim() }, i, i + 1));
      }
    }
    // The first report, read as jsonMessages reads it, each message where its object is.
    for (const { value, where } of jsonDocumentsAt(s, JSON_MARK)) {
      for (const r of Array.isArray(value) ? value : value.messages) {
        const { start, end } = where(r);
        add(withSource({ file: r.path, line: r.line, col: Number.isInteger(r.column) ? r.column : undefined,
          title: r.symbol, code: r["message-id"] ?? r.messageId,
          severity: "error", message: String(r.message ?? "").trim() }, start, end));
      }
      break;
    }
    const stopping = all.filter((f) => STOPS_THE_RUN.test(f.code));
    // A real error alongside a missing docstring buries the error, so when there is one
    // the advisories step aside and are counted instead.
    const chosen = stopping.length ? stopping : all;
    const advisory = all.length - chosen.length;
    const failures = chosen;

    if (!failures.length) return null;
    const n = failures.length;
    return {
      tool: "pylint",
      summary: `${n} problem${n === 1 ? "" : "s"}` +
        (advisory ? `, ${advisory} advisory hidden` : ""),
      failures,
    };
  },
};
