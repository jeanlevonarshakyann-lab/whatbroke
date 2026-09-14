import { colonPlaces, elements, jsonDocuments, jsonDocumentsAt, lineAt, tailFirst, xmlAttributes, xmlText } from "../util.js";
import { withSource } from "../ownership.js";
// golangci-lint is what a Go CI job usually fails on. Its findings look almost exactly
// like `go build`'s, and go's parser was claiming them - so a lint run came back as
// "6 compile errors" from a tool called `go build`, with the linter's name left sitting
// inside the message where it could not be grouped on.
//
//   main.go:10:15: Error return value of `f.Close` is not checked (errcheck)
//   	defer f.Close()
//   	             ^
//
// What separates the two is the linter's name in brackets at the end of the line. go's
// own diagnostics put their brackets in the middle - "cannot use 42 (untyped int
// constant) as string value" - and never at the end, and go prints no source line or
// caret under them at all.
//
// The file has to be a .go file, which is the other half of the bound and not a detail:
// a trailing "(name)" is also how pylint ends every line - "Undefined variable 'x'
// (undefined-variable)" - and how yamllint's parsable format ends its own. Without it
// this claimed both of them, and 42 ordered pairs in test/mixed.js changed their
// failures. golangci-lint lints Go, so the extension is something the tool itself
// guarantees rather than a guess about shape.
// `file.go:line:col: message (linter)` - the pattern
//   /^(?:\.[\\/])?(.+?\.go):(\d+):(\d+):[^\S\n]+(.+?)[^\S\n]+\(([\w-]+)\)[^\S\n]*$/
// matched without reading a long line again from every colon in it. The `./` in front
// is optional and greedy: the pattern tries the file without it only once it has failed
// with it.
export const issueLine = (line) => tailFirst(line, {
  tail: /\(([\w-]+)\)[^\S\n]*$/, spaceBefore: 1, emptyMessage: false,
  heads: function* (l, c, clear) {
    for (const from of /^\.[\\/]/.test(l) ? [2, 0] : [0]) {
      yield* colonPlaces(l, from, c, /:(\d+):(\d+):/y, (p) => p - from >= 4 && l.endsWith(".go", p) && clear(from, p));
    }
  },
});
const CARETS = /^[^\S\n]*\^[^\S\n]*$/;
// golangci-lint ends with its own count and a breakdown by linter.
const TALLY = /^(\d+) issues?:[^\S\n]*$/m;
const BREAKDOWN = /^\* [\w-]+: \d+[^\S\n]*$/m;

// Every other output golangci-lint writes read as nothing, and its JUnit report came back
// as five failures called "Details:". They all hold the same issues:
//
//   --output.tab         main.go:10:15        errcheck     Error return value of ...
//   --output.checkstyle  <error column="15" line="10" message="..." source="errcheck">
//   --output.code-climate  {"description":"errcheck: Error return value ...","check_name":"errcheck", ...}
//   --output.junit-xml   <failure message="main.go:10:15: Error ..."><![CDATA[... Category: errcheck ...
//   --output.teamcity    ##teamcity[inspection typeId='errcheck' message='...' file='main.go' line='10' ...]
//   --output.json        {"Issues":[{"FromLinter":"errcheck","Text":"...","Pos":{...}}], "Report": ...}
//   --output.sarif       {"runs":[{"tool":{"driver":{"name":"golangci-lint"}}, "results": [...]}]}
//
// The ones that name no tool are Go's by their files, and golangci-lint's by the tally it
// prints after any of them.
const GO_FILE = /\.go$/;
const TAB = /^(?:\.[\\/])?(\S+?\.go):(\d+):(\d+)[^\S\n]+([\w-]+)[^\S\n]{2,}(\S.*?)[^\S\n]*$/;
const CHECKSTYLE_FILE = /<file\b([^>]*)>([\s\S]*?)<\/file>/dg;
const CHECKSTYLE_ERROR = /<error\b([^>]*?)(?:\/>|>[\s\S]*?<\/error>)/g;
const CHECKSTYLE_FILE_ELEMENT = { open: /<file\b/, close: () => "</file>" };
const CHECKSTYLE_ERROR_ELEMENT = { open: /<error\b/, close: () => "</error>", selfClosing: true };
// Neither tag may close itself: bun's JUnit writes `<failure type="AssertionError" />`, and
// read as an opening tag its body ran on into the next report's first failure.
// What stands between a case and its failure is not counted on either, only that it is not
// another case - a log another tool writes to can put a line of its own there.
const JUNIT_CASE = /<testcase\b([^>]*?)(?<!\/)>(?:(?!<\/?testcase\b)[\s\S])*?<failure\b([^>]*?)(?<!\/)>([\s\S]*?)<\/failure>/g;
const JUNIT_WHERE = /^(.+\.go):(\d+):(\d+)$/;
const TEAMCITY = /^##teamcity\[inspection\b(.*)\][^\S\n]*$/;
const TEAMCITY_ATTR = /(\w+)='((?:\|.|[^|'])*)'/g;
const TEAMCITY_OWN = /^##teamcity\[inspectionType\b[^\n]*category='Golangci-lint reports'/m;
// TeamCity escapes with a bar: |' |n |r || |[ |]
const teamcity = (v) => v.replace(/\|(.)/g, (_, c) => ({ n: "\n", r: "\r" })[c] ?? c);
const JSON_MARK = (v) => !!v && typeof v === "object" && Array.isArray(v.Issues) && !!v.Report &&
  v.Issues.every((i) => typeof i?.FromLinter === "string" && typeof i.Pos?.Filename === "string");
const CLIMATE_MARK = (v) => Array.isArray(v) && v.length > 0 && v.every((d) =>
  typeof d?.check_name === "string" && typeof d.location?.path === "string" && GO_FILE.test(d.location.path) &&
  String(d.description ?? "").startsWith(`${d.check_name}: `));
const SARIF_MARK = (v) => !!v && typeof v === "object" && Array.isArray(v.runs) &&
  v.runs.some((r) => r?.tool?.driver?.name === "golangci-lint");
const positive = (n) => (Number.isInteger(+n) && +n > 0 ? +n : undefined);

/** The issues of every machine format golangci-lint writes, in `s` - each with the lines
 *  [from, to) it was read from when `placed`, which deciding whether to claim a log does
 *  not need and reading a report for them costs. */
function reported(s, lines, placed = false) {
  const out = [];
  const documents = (mark) => (placed ? [...jsonDocumentsAt(s, mark)]
    : [...jsonDocuments(s, mark)].map((value) => ({ value, where: () => ({ start: 0, end: 1 }) })));
  const inText = (at, length) => ({ from: lineAt(s, at), to: lineAt(s, at + length - 1) + 1 });
  const tallied = TALLY.test(s) && BREAKDOWN.test(s);
  if (tallied) {
    lines.forEach((line, i) => {
      const m = line.match(TAB);
      if (m) out.push({ file: m[1], line: +m[2], col: +m[3], code: m[4], message: m[5], from: i, to: i + 1 });
    });
  }
  if (tallied && s.includes("<checkstyle")) {
    for (const f of elements(s, CHECKSTYLE_FILE, CHECKSTYLE_FILE_ELEMENT)) {
      const file = xmlAttributes(f[1]).name;
      if (!GO_FILE.test(file ?? "")) continue;
      for (const e of elements(f[2], CHECKSTYLE_ERROR, CHECKSTYLE_ERROR_ELEMENT)) {
        const a = xmlAttributes(e[1]);
        if (!a.source) continue;
        out.push({ file, line: positive(a.line), col: positive(a.column), code: a.source, message: String(a.message ?? "").trim(),
          ...inText(f.indices[2][0] + e.index, e[0].length) });
      }
    }
  }
  if (s.includes("Category: ")) {
    // The body read is the failure's, so it is the failure's closing tag that has to follow.
    for (const c of elements(s, JUNIT_CASE, { open: /<testcase\b/, close: () => "</failure>" })) {
      const test = xmlAttributes(c[1]), failure = xmlAttributes(c[2]);
      const where = String(test.classname ?? "").match(JUNIT_WHERE);
      const body = c[3].replace(/^\s*<!\[CDATA\[|\]\]>\s*$/g, "");
      // The body is golangci-lint's own layout: the message, then Category, File, Line and
      // Details, the last being the source line.
      if (!where || !test.name || !new RegExp(`^Category: ${test.name}$`, "m").test(body)) continue;
      const said = `${where[1]}:${where[2]}:${where[3]}: `;
      const message = String(failure.message ?? "");
      const stmt = body.match(/^Details: (.*)$/m)?.[1].trim();
      // The test case, from its opening tag to its failure's closing one.
      out.push({ file: where[1], line: +where[2], col: +where[3], code: test.name,
        message: (message.startsWith(said) ? message.slice(said.length) : message).trim(), ...(stmt ? { stmt } : {}),
        ...inText(c.index, c[0].length) });
    }
  }
  if (TEAMCITY_OWN.test(s)) {
    lines.forEach((line, index) => {
      const m = line.match(TEAMCITY);
      if (!m) return;
      const a = Object.fromEntries([...m[1].matchAll(TEAMCITY_ATTR)].map(([, k, v]) => [k, teamcity(v)]));
      if (!a.typeId || !a.file) return;
      out.push({ file: a.file, line: positive(a.line), code: a.typeId, message: String(a.message ?? "").trim(), from: index, to: index + 1 });
    });
  }
  // A record in a report is read from its own object's lines.
  const record = (where, node) => { const { start, end } = where(node); return { from: start, to: end }; };
  for (const { value: doc, where } of s.includes('"Issues"') ? documents(JSON_MARK) : []) {
    for (const i of doc.Issues) {
      const stmt = typeof i.SourceLines?.[0] === "string" ? i.SourceLines[0].trim() : undefined;
      out.push({ file: i.Pos.Filename, line: positive(i.Pos.Line), col: positive(i.Pos.Column), code: i.FromLinter,
        message: String(i.Text ?? "").trim(), ...(stmt ? { stmt } : {}), ...record(where, i) });
    }
  }
  for (const { value: doc, where } of s.includes('"check_name"') ? documents(CLIMATE_MARK) : []) {
    for (const d of doc) {
      out.push({ file: d.location.path, line: positive(d.location.lines?.begin), code: d.check_name,
        message: d.description.slice(d.check_name.length + 2).trim(), ...record(where, d) });
    }
  }
  for (const { value: doc, where } of s.includes('"golangci-lint"') ? documents(SARIF_MARK) : []) {
    for (const run of doc.runs.filter((r) => r?.tool?.driver?.name === "golangci-lint")) {
      for (const r of run.results ?? []) {
        const at = r?.locations?.[0]?.physicalLocation;
        if (typeof at?.artifactLocation?.uri !== "string" || typeof r.ruleId !== "string") continue;
        out.push({ file: at.artifactLocation.uri, line: positive(at.region?.startLine), col: positive(at.region?.startColumn),
          code: r.ruleId, message: String(r.message?.text ?? "").trim(), ...record(where, r) });
      }
    }
  }
  return out;
}

export default {
  name: "golangci-lint",
  // Strings a log has to hold for this parser to read anything from it - see src/router.js.
  signals: [".go:", "issues:", "Category: ", "Golangci-lint reports", "\"Issues\"", "\"check_name\"", "\"golangci-lint\""],
  category: "lint",
  commands: ["golangci-lint"],

  // A trailing "(name)" alone is thin, so it has to be corroborated by something else
  // golangci-lint writes and go does not: its tally, or the caret it draws under the
  // source line. Either is enough; both are absent from every go build log.
  detect(s) {
    const lines = s.split("\n");
    if (reported(s, lines).length) return true;
    if (!lines.some((l) => issueLine(l))) return false;
    return TALLY.test(s) || lines.some((l, i) => issueLine(l) && CARETS.test(lines[i + 2] ?? ""));
  },

  extract(s) {
    const lines = s.split("\n");
    const failures = [];
    for (let i = 0; i < lines.length; i++) {
      const m = issueLine(lines[i]);
      if (!m) continue;
      const stmt = CARETS.test(lines[i + 2] ?? "") ? lines[i + 1].trim() : undefined;
      // The issue, and the source and caret under it when they are there.
      failures.push(withSource({
        file: m[1], line: +m[2], col: +m[3],
        // The linter that raised it is what you would disable, and what groups a run of
        // findings into one thing to fix.
        title: m[5], code: m[5], severity: "error", message: m[4],
        ...(stmt ? { stmt } : {}),
      }, i, stmt ? i + 3 : i + 1));
    }
    for (const f of reported(s, lines, true)) {
      failures.push(withSource({
        file: f.file, line: f.line, ...(f.col ? { col: f.col } : {}),
        title: f.code, code: f.code, severity: "error", message: f.message, ...(f.stmt ? { stmt: f.stmt } : {}),
      }, f.from, f.to));
    }
    if (!failures.length) return null;
    const declared = s.match(TALLY);
    const n = failures.length;
    return {
      tool: "golangci-lint",
      summary: `${n} problem${n === 1 ? "" : "s"}` +
        (declared && +declared[1] !== n ? ` of ${declared[1]} reported` : ""),
      failures,
    };
  },
};
