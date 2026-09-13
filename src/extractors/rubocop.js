import { githubAnnotations, jsonDocuments, xmlAttributes, xmlText } from "../util.js";
// RuboCop is what a Ruby CI job usually fails on, and its output had no parser: the
// fallback scraped the lines but dropped the column, the cop name and the severity, and
// reported a style convention as an error.
//
//   app.rb:2:3: W: [Correctable] Lint/UselessAssignment: Useless assignment - unused.
//     unused = 42
//     ^^^^^^
//
// The severity is a single letter and the cop is Category/Name, and requiring both is
// what keeps this off every other tool's `file:line:col:` line. `[Correctable]` is
// rubocop telling you `-a` would fix it, not part of what is wrong.
//
// --format tap writes the same line as a TAP comment, `# app.rb:2:3: W: ...`, under a
// `not ok` per file - and the TAP parser, asked first, read two failures called
// "app/cart.rb" with nothing in them.
const COP = String.raw`[A-Z]\w*\/[A-Z]\w*`;
const OFFENSE = new RegExp(String.raw`^(#[^\S\n])?(.+?):(\d+):(\d+):[^\S\n]+([CWEFRI]):[^\S\n]+(?:\[[^\]]*\][^\S\n]+)?(${COP}):[^\S\n]+(.+?)[^\S\n]*$`);
// The carets rubocop draws under the offending span. They are what says the line above
// them is the source and not more prose - the syntax-error case puts a note about the
// parser version there instead, and quoting that as the offending line would be wrong.
const CARETS = /^[^\S\n]*\^+[^\S\n]*$/;
const TALLY = /^\d+ files? inspected, (\d+) offenses? detected/m;

// --format simple, and quiet, which is simple without the tally when nothing is wrong:
//
//   == app/cart.rb ==
//   C:  3: 11: [Correctable] Layout/SpaceInsideParens: Space inside parentheses detected.
const SIMPLE_FILE = /^== (.+) ==[^\S\n]*$/;
const SIMPLE_ROW = new RegExp(String.raw`^([CWEFRI]):[^\S\n]*(\d+):[^\S\n]*(\d+):[^\S\n]+(?:\[[^\]]*\][^\S\n]+)?(${COP}):[^\S\n]+(.+?)[^\S\n]*$`);

// --format markdown, which prints no column:
//
//   ### app/cart.rb - (4 offenses)
//     * **Line # 3 - convention:** Layout/SpaceInsideParens: Space inside parentheses detected.
const MARKDOWN_DOC = /^# RuboCop Inspection Report[^\S\n]*$/m;
const MARKDOWN_FILE = /^### (.+?) - \(\d+ offenses?\)[^\S\n]*$/;
const MARKDOWN_ROW = new RegExp(String.raw`^[^\S\n]*\*[^\S\n]+\*\*Line # (\d+) - (\w+):\*\*[^\S\n]+(${COP}):[^\S\n]+(.+?)[^\S\n]*$`);

// --format json names rubocop in its metadata.
const JSON_MARK = (v) => !!v && typeof v === "object" && typeof v.metadata?.rubocop_version === "string" &&
  Array.isArray(v.files);

// --format junit is one suite named rubocop, a case for every cop there is - a thousand
// of them for two files - and a failure per offense, with where it is on the line below:
//
//   <testcase classname='app.cart' name='Style/SymbolProc'>
//     <failure type='Style/SymbolProc' message='Style/SymbolProc: Pass `&amp;:price` ...'>
//       /app/cart.rb:4:13
//     </failure>
//
// It is read a line at a time rather than as a document. A long log capped to its
// interesting lines keeps each failure and its location and loses the thousand passing
// cases around them, closing tags included. It records no severity.
const JUNIT_SUITE_LINE = /<testsuite\b[^>]*\bname=(['"])rubocop\1/;
const JUNIT_END_LINE = /<\/testsuites>|<testsuite\b/;
const JUNIT_FAILURE_LINE = /<failure\b([^>]*)>[^\S\n]*$/;
const WHERE = /^[^\S\n]*(.+):(\d+):(\d+)[^\S\n]*$/;

// Every machine format starts the message with the cop's name, which the text forms
// print in its own place.
const LETTER = { refactor: "R", convention: "C", warning: "W", error: "E", fatal: "F", info: "I" };
const unnamed = (message, cop) => {
  const text = String(message ?? "").trim();
  return text.startsWith(`${cop}: `) ? text.slice(cop.length + 2) : text;
};

/** Every offense in `s`, in whichever of rubocop's formats it holds. */
function offenses(s) {
  const lines = s.split("\n");
  const found = [];
  let simpleFile, markdownFile;
  const markdown = MARKDOWN_DOC.test(s);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(OFFENSE);
    if (m) {
      // In TAP the source and the carets under it are comments too, and a line that is
      // not a comment is not part of this offense - it is whatever else was writing to
      // the same log, and quoting it made one offense two.
      const own = (l) => (!m[1] ? l : /^#/.test(l ?? "") ? l.replace(/^#[^\S\n]?/, "") : undefined);
      const source = own(lines[i + 1]);
      const stmt = source !== undefined && CARETS.test(own(lines[i + 2]) ?? "") ? source.trim() : undefined;
      found.push({
        file: m[2], line: +m[3], col: +m[4], letter: m[5],
        code: m[6], message: m[7], ...(stmt ? { stmt } : {}),
      });
      continue;
    }
    const header = lines[i].match(SIMPLE_FILE);
    if (header) { simpleFile = header[1]; continue; }
    const row = simpleFile && lines[i].match(SIMPLE_ROW);
    if (row) {
      found.push({ file: simpleFile, line: +row[2], col: +row[3], letter: row[1], code: row[4], message: row[5] });
      continue;
    }
    if (!markdown) continue;
    const section = lines[i].match(MARKDOWN_FILE);
    if (section) { markdownFile = section[1]; continue; }
    const item = markdownFile && lines[i].match(MARKDOWN_ROW);
    if (item) {
      found.push({ file: markdownFile, line: +item[1], letter: LETTER[item[2]], code: item[3], message: item[4] });
    }
  }

  const docs = s.includes('"rubocop_version"') ? [...jsonDocuments(s, JSON_MARK)] : [];
  for (const file of docs.flatMap((d) => d.files)) {
    for (const o of file?.offenses ?? []) {
      if (typeof o?.cop_name !== "string" || typeof file.path !== "string") continue;
      const at = o.location ?? {};
      found.push({
        file: file.path, line: at.start_line ?? at.line, col: at.start_column ?? at.column,
        letter: LETTER[o.severity], code: o.cop_name, message: unnamed(o.message, o.cop_name),
      });
    }
  }

  if (JUNIT_SUITE_LINE.test(s)) {
    const cop = new RegExp(String.raw`^${COP}$`);
    let inSuite = false;
    for (let i = 0; i < lines.length; i++) {
      if (JUNIT_SUITE_LINE.test(lines[i])) { inSuite = true; continue; }
      if (JUNIT_END_LINE.test(lines[i])) { inSuite = false; continue; }
      const failure = inSuite && lines[i].match(JUNIT_FAILURE_LINE);
      if (!failure) continue;
      const a = xmlAttributes(failure[1]);
      // The location is the failure's body. Another tool writing to the same log can put
      // a line of its own in between, so the body is looked for up to its closing tag.
      let where = null;
      for (let j = i + 1; j <= i + 3 && j < lines.length && !/<\/?(?:failure|testcase)\b/.test(lines[j]); j++) {
        where = xmlText(lines[j]).match(WHERE);
        if (where) break;
      }
      if (!where || !cop.test(a.type ?? "")) continue;
      found.push({ file: where[1], line: +where[2], col: +where[3], code: a.type, message: unnamed(a.message, a.type) });
    }
  }

  // --format github writes no title, and puts the cop in front of the message instead.
  if (/^[^\S\n]*::(?:error|warning)[^\S\n]/m.test(s)) {
    const named = new RegExp(String.raw`^(${COP}):[^\S\n]+(.+)$`);
    for (const a of githubAnnotations(s)) {
      const m = a.props.title ? null : a.message.match(named);
      if (!m || !a.props.file || !(+a.props.line > 0)) continue;
      found.push({ file: a.props.file, line: +a.props.line, ...(+a.props.col > 0 ? { col: +a.props.col } : {}),
        code: m[1], message: m[2].trim() });
    }
  }
  return found;
}

export default {
  name: "rubocop",
  category: "lint",
  commands: ["rubocop"],

  detect: (s) => offenses(s).length > 0,

  extract(s) {
    const found = offenses(s);
    if (!found.length) return null;
    // rubocop's ladder is F, E, W, C, R. Only the first two are a failure in their own
    // right; the rest are house style, and pylint - the same shape in the other
    // ecosystem - sets those aside behind a real error the same way. rubocop exits
    // non-zero on any offence, so when there is no error the conventions are the reason
    // and saying nothing would be worse than saying they are only conventions. The junit
    // and github formats record no severity, so everything they hold is shown.
    const errors = found.filter((f) => /[EF]/.test(f.letter ?? ""));
    const shown = errors.length ? errors : found;
    const hidden = found.length - shown.length;
    const n = shown.length;
    const declared = s.match(TALLY);
    return {
      tool: "rubocop",
      summary: `${n} problem${n === 1 ? "" : "s"}` +
        (hidden ? `, ${hidden} advisory hidden` : "") +
        (!errors.length && declared && +declared[1] !== n ? ` of ${declared[1]} offences` : ""),
      failures: shown.map(({ file, line, col, code, message, stmt }) => ({
        file, line, ...(col !== undefined ? { col } : {}), title: code, code, message,
        ...(stmt ? { stmt } : {}), severity: "error",
      })),
    };
  },
};
