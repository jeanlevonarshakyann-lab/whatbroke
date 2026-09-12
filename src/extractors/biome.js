import { findJsonDocument, githubAnnotations, xmlAttributes, xmlText } from "../util.js";
// Biome heads each finding with the location and the rule, then says what is wrong on
// the line under it, then draws the source and offers fixes:
//
//   biomebad.js:1:7 lint/correctness/noUnusedVariables  FIXABLE  ━━━━━━━━━━━━━
//
//     ! This variable x is unused.
//
//     > 1 │ const x = ;
//         │       ^
//
//     i Unused variables are often the result of typos ...
//     i Unsafe fix: If this is intentional, prepend x with an underscore.
//
// The "i" lines are advice and the diff under them is the fix; neither is the diagnosis.
// The rule is the last field of the header and is what you would disable.
//
// As with pylint, the filename can hold a space - `my project/src/app.js:1:11 parse ━━━`
// - and (\S+?) matched none of it. The rule name and the rule line that follow are what
// bound it; the name itself is not a shape worth insisting on.
//
// Not every section is a lint rule, and requiring one lost the errors. `parse` heads a
// file biome could not read at all, and `format` heads one whose formatting differs -
// which under `biome format` is the only finding there is. Both were dropped, so a log
// reading "Found 2 errors. Found 1 warning." came back as the one warning.
const HEAD_RE = /^(.+?):(\d+):(\d+)[^\S\n]+(\S+?)(?:[^\S\n]+(?:FIXABLE|INFO|WARNING|ERROR|PARSE))*[^\S\n]*━*[^\S\n]*$/;
// `my project/src/fmt.js format ━━━` - biome's file-level sections carry no line or
// column. The run's closing banner is `format ━━━` or `check ━━━`, the command's own
// name with nothing in front of it - until a monorepo runner prefixes every line, and
// then `api:lint: check ━━━` has something in front of it and was read as a file called
// `api:lint:`. Nothing before the category is not the test. Being a filename is, and a
// filename here ends in an extension.
const FILE_HEAD_RE = /^(\S.*?\.\w+)[^\S\n]+(parse|format|organizeImports|assist)[^\S\n]*━+[^\S\n]*$/;
// Said once the real diagnosis has already been printed above it.
const RESTATEMENT = /^(?:Code formatting aborted due to parsing errors|Some errors were emitted)/;
// "  ! This variable x is unused." - the severity glyph, then the message.
const MESSAGE_RE = /^[^\S\n]*([!×✖⚠])[^\S\n]+(\S.*?)[^\S\n]*$/;
// "  > 1 │ const x = ;" - the marked line of the source frame.
const MARKED_RE = /^[^\S\n]*>[^\S\n]*(\d+)[^\S\n]*│[^\S\n]?(.*)$/;
const TALLY_RE = /^(?:Checked|Found) \d+|^[^\S\n]*\d+ error[s]? found/m;

/** A section header, or null. Biome heads a finding either with a location and a rule or
 *  - for a whole file it could not parse or format - with just the file and the section
 *  name. A rule is a path; `parse` and `format` are biome's own and are neither. */
function header(line) {
  const h = line.match(HEAD_RE);
  if (h) {
    if (prefixed(h[1])) return null;
    if (!h[4].includes("/") && !/^(?:parse|format|organizeImports|assist)$/.test(h[4])) return null;
    return { file: h[1], line: +h[2], col: +h[3], title: h[4], code: h[4] };
  }
  const f = line.match(FILE_HEAD_RE);
  if (f && !prefixed(f[1])) return { file: f[1], title: f[2], code: f[2] };
  return null;
}

/** Letting the name hold a space also let it hold a monorepo runner's prefix, and biome
 *  read `api:lint: biomebad.js` as a file - swallowing the wrapper, so the stripped log
 *  no longer looked like the better parse and normalization stopped happening. A path
 *  segment can contain a space; `api:lint: ` is a colon with whitespace after it, which
 *  is what every runner writes and what no path does. `C:\src` is untouched: the colon
 *  there is followed by a separator, not a space. */
function prefixed(name) {
  return /:[^\S\n]/.test(name);
}

// --------------------------------------------------------------- the other reporters
//
// `--reporter` changes how the same run is printed, and biome has five of them. None
// was read: a run that reported three violations came back with no diagnosis at all.
//
// Each is bounded by something biome itself declares, never by the shape of the format
// alone - the GitHub annotation, the GitLab Code Quality array and the JUnit document
// are all formats other tools write too, and claiming one of those on sight would mean
// claiming their logs.
//
// A rule's category is a path: `lint/suspicious/noDebugger`. Biome's own sections are
// single words - `parse`, `format`, `organizeImports`, `assist`.
const CATEGORY = /^(?:[\w-]+\/[\w-]+(?:\/[\w-]+)*|parse|format|organizeImports|assist)$/;

// --reporter=json. `command` is the subcommand that ran, and `summary` counts what it
// checked; no other tool writes a document carrying both beside a diagnostics array.
const JSON_MARK = (v) => !!v && typeof v === "object" && !Array.isArray(v) &&
  typeof v.command === "string" && !!v.summary && Array.isArray(v.diagnostics) &&
  v.diagnostics.every((d) => d && typeof d.category === "string" && !!d.location);

// --reporter=gitlab. GitLab's Code Quality format is a generic one, so what says this is
// biome is the check name: a rule category, not a free-text check name.
const GITLAB_MARK = (v) => Array.isArray(v) && v.length > 0 && v.every((d) =>
  d && typeof d.check_name === "string" && CATEGORY.test(d.check_name) &&
  typeof d.fingerprint === "string" && !!d.location && typeof d.location.path === "string");

// --reporter=junit writes a JUnit document that names itself, and names biome again on
// every suite. The rule comes back as a class path - `org.biome.lint.suspicious.noDebugger`
// - which is biome's own category with the separators changed, so it is changed back.
// The scan has to stay inside biome's own document. A JUnit file is what every runner
// writes, and a log holding two of them - biome's report beside deno's - handed biome
// deno's suites as well, because deciding on the whole log and then reading the whole
// log are not the same bound. The document is cut out first, and a case still has to
// carry biome's own class path to be read.
const JUNIT_DOC_RE = /<testsuites\b[^>]*\bname="Biome"[^>]*>([\s\S]*?)<\/testsuites>/g;
const JUNIT_SUITES = /<testsuites\b[^>]*\bname="Biome"/;
const BIOME_CLASS = /^org\.biome\./;
const JUNIT_CASE_RE = /<testcase\b([^>]*)>([\s\S]*?)<\/testcase>/g;
const JUNIT_SUITE_RE = /<testsuite\b([^>]*)>([\s\S]*?)<\/testsuite>/g;
const JUNIT_FAILURE_RE = /<failure\b([^>]*?)(?:\/>|>([\s\S]*?)<\/failure>)/;

// --reporter=summary. Biome heads its own sections here, and lists the files under one
// of them. There are no line numbers anywhere in this format, so none are invented.
const SUMMARY_SECTION = /^[^\S\n]*reporter\/(violations|format)[^\S\n]*━+[^\S\n]*$/;
const SUMMARY_SECTION_ANY = /^[^\S\n]*reporter\/(?:violations|format)[^\S\n]*━+[^\S\n]*$/m;
const SUMMARY_FILES = /^[^\S\n]*i[^\S\n]+The following files (?:have violations|need to be formatted):[^\S\n]*$/;
const SUMMARY_ITEM = /^[^\S\n]*-[^\S\n]+(\S.*?)(?:[^\S\n]+\(([^)]*)\))?[^\S\n]*$/;
const SUMMARY_RULES = /^[^\S\n]*i[^\S\n]+The following lint rules have violations:[^\S\n]*$/;
const SUMMARY_RULE_ROW = /^[^\S\n]*([\w-]+\/[\w-]+(?:\/[\w-]+)*)[^\S\n]{2,}\d+/;

/** Every reading of `s` that came from one of biome's machine reporters. */
function reported(s) {
  const out = [];
  // Each scan is skipped unless the log holds the one string that reporter must
  // print, so asking biome about a large log it has nothing to do with stays cheap.
  const doc = s.includes('"diagnostics"') ? findJsonDocument(s, JSON_MARK) : null;
  for (const d of doc?.diagnostics ?? []) {
    const start = d.location.span?.[0] ?? d.location.start ?? {};
    out.push({
      file: d.location.path?.file ?? d.location.path ?? undefined,
      // A whole-file notice is padded out to a position biome does not really mean -
      // line 0 in this reporter, line 1 in the next. Line 0 does not exist, so it is
      // the one padding that can be recognised, and it is dropped rather than shown.
      line: start.line > 0 ? start.line : undefined,
      col: start.line > 0 && start.column > 0 ? start.column : undefined,
      title: d.category, code: d.category,
      severity: d.severity === "error" || d.severity === "fatal" ? "error" : "warning",
      message: String(d.message ?? "").trim(),
    });
  }

  // --reporter=github. Every tool's annotations look alike, so what marks these as
  // biome's is the title: biome puts its rule category there, and the formatters that
  // share this shape either write no title or write a sentence.
  for (const a of (/^[^\S\n]*::(?:error|warning|notice)[^\S\n]/m.test(s) ? githubAnnotations(s) : [])) {
    const title = a.props.title;
    if (!title || !CATEGORY.test(title) || !a.props.file) continue;
    const line = Number(a.props.line);
    const col = Number(a.props.col ?? a.props.column);
    out.push({
      file: a.props.file,
      line: Number.isFinite(line) && line > 0 ? line : undefined,
      col: Number.isFinite(col) && col > 0 ? col : undefined,
      title, code: title,
      severity: a.severity === "error" ? "error" : "warning",
      message: a.message.trim(),
    });
  }

  for (const d of (s.includes('"check_name"') ? findJsonDocument(s, GITLAB_MARK) : null) ?? []) {
    out.push({
      file: d.location.path,
      line: d.location.lines?.begin > 0 ? d.location.lines.begin : undefined,
      title: d.check_name, code: d.check_name,
      // GitLab's own scale. Biome writes error as critical and warning as major.
      severity: d.severity === "critical" || d.severity === "blocker" ? "error" : "warning",
      message: String(d.description ?? "").trim(),
    });
  }

  for (const doc of JUNIT_SUITES.test(s) ? s.matchAll(JUNIT_DOC_RE) : []) {
    for (const suite of doc[1].matchAll(JUNIT_SUITE_RE)) {
      const file = xmlAttributes(suite[1]).name;
      for (const test of suite[2].matchAll(JUNIT_CASE_RE)) {
        const a = xmlAttributes(test[1]);
        const f = test[2].match(JUNIT_FAILURE_RE);
        if (!f || !BIOME_CLASS.test(String(a.name ?? ""))) continue;
        // `org.biome.lint.suspicious.noDebugger` is the category with its separators
        // changed for a format that expects a class name; this changes them back.
        const code = String(a.name ?? "").replace(/^org\.biome\./, "").replace(/\./g, "/");
        out.push({
          file, line: +a.line > 0 ? +a.line : undefined,
          col: +a.column > 0 ? +a.column : undefined,
          title: code, code,
          // This reporter records no severity at all: biome's warnings and its errors
          // are both written as failures. Nothing here can tell them apart, so nothing
          // here pretends to - the run failed and these are what it said.
          severity: "error",
          message: xmlText(xmlAttributes(f[1]).message ?? f[2] ?? "").trim(),
        });
      }
    }
  }

  return out;
}

/** The files a `--reporter=summary` run named, with the counts it gave for each.
 *
 *  This reporter prints no line numbers anywhere, so a finding from it is about a file
 *  and says so. The rules it lists are counted across the whole run and cannot be
 *  attached to any one file, so they go in the run's own summary line instead. */
function summarised(s) {
  const files = [];
  const rules = [];
  let listing = null;
  for (const line of s.split("\n")) {
    if (SUMMARY_SECTION.test(line)) { listing = null; continue; }
    if (SUMMARY_FILES.test(line)) { listing = "files"; continue; }
    if (SUMMARY_RULES.test(line)) { listing = "rules"; continue; }
    if (listing === "rules") {
      const r = line.match(SUMMARY_RULE_ROW);
      if (r) { rules.push(r[1]); continue; }
    }
    if (listing !== "files") continue;
    const m = line.match(SUMMARY_ITEM);
    if (!m) { if (line.trim()) listing = null; continue; }
    files.push({ file: m[1], counts: m[2] });
  }
  return { files, rules };
}

export default {
  name: "biome",
  category: "lint",
  commands: ["biome"],

  detect: (s) => s.split("\n").some((l) => header(l) !== null) ||
    reported(s).length > 0 || SUMMARY_SECTION_ANY.test(s),

  extract(s) {
    const lines = s.split("\n");
    const found = [];
    for (let i = 0; i < lines.length; i++) {
      const h = header(lines[i]);
      if (!h) continue;

      let message = "", marker = "", stmt;
      for (let j = i + 1; j < lines.length && j <= i + 8; j++) {
        if (header(lines[j])) break;
        const m = lines[j].match(MESSAGE_RE);
        if (m && !message) { marker = m[1]; message = m[2]; continue; }
        const marked = lines[j].match(MARKED_RE);
        if (marked && !stmt) { stmt = marked[2].trim(); }
      }
      // Biome says which it is with the glyph it draws: × and ✖ for what failed, ! and
      // ⚠ for what it merely disliked. It always draws one, so a section without one is
      // a section this did not actually read - which is what a monorepo runner's prefix
      // produces, and defaulting those to "error" made a wrapped log parse to MORE than
      // the same log clean, so the strip stopped looking like an improvement and stopped
      // being applied.
      if (!marker) continue;
      if (RESTATEMENT.test(message)) continue;
      found.push({
        ...h, severity: marker === "!" || marker === "\u26a0" ? "warning" : "error",
        message: message || h.code, stmt,
      });
    }
    // ...and the same run as one of biome's machine reporters printed it. A log can
    // hold both - CI keeps the human output and writes the report beside it - so what
    // the text form already said is not said again. The reporters disagree over whether
    // a column is printed at all, so the column is not part of what makes a finding
    // distinct.
    const seen = new Set(found.map((f) => [f.file, f.line, f.code].join("\u0000")));
    for (const f of reported(s)) {
      // The machine reporters carry biome's closing remarks as diagnostics of their own,
      // and "Code formatting aborted due to parsing errors" is the parse error above it
      // said a second time. The text reader already steps over those; so does this, or a
      // file biome could not parse is reported as two things going wrong instead of one.
      if (RESTATEMENT.test(f.message)) continue;
      const key = [f.file, f.line, f.code].join("\u0000");
      if (seen.has(key)) continue;
      seen.add(key);
      found.push(f);
    }

    // ...and the summary reporter, which is a run in its own right rather than a last
    // resort: a log can hold a `biome format` run and a `--reporter=summary` run, and
    // reading the summary only when nothing else was found lost the second one whole.
    const { files, rules } = summarised(s);
    for (const { file, counts } of files) {
      const key = [file, undefined, "violations"].join("\u0000");
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({
        file, title: "violations", label: "violations", severity: "error",
        message: counts ? `biome reported ${counts} here` : "biome reported violations here",
      });
    }

    if (!found.length) return null;
    // When the summary reporter is all there was, the run's own line says what it said:
    // how many files, and which rules - counted over the whole run, so they cannot be
    // attached to any one file.
    if (found.every((f) => f.label === "violations")) {
      const only = found.length;
      return {
        tool: "biome",
        // "biome would not accept these" says nothing went wrong, and the run exited
        // non-zero. The guarantees suite catches a headline that reads like success.
        summary: `${only} file${only === 1 ? "" : "s"} failed biome's checks` +
          (rules.length ? ` — ${rules.join(", ")}` : ""),
        failures: found,
      };
    }
    // The house rule everywhere else here: an error is what failed the run, and warnings
    // stand behind it - unless they are all there is, and then they are the reason.
    const errors = found.filter((f) => f.severity === "error");
    const shown = (errors.length ? errors : found).map((f) => ({ ...f, severity: "error" }));
    const hidden = found.length - shown.length;
    const n = shown.length;
    return {
      tool: "biome",
      summary: `${n} ${errors.length ? "error" : "warning"}${n === 1 ? "" : "s"}` +
        (hidden ? ` — ${hidden} warning${hidden > 1 ? "s" : ""} hidden` : ""),
      failures: shown,
    };
  },
};
