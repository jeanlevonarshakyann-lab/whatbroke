import { elements, firstElement, githubAnnotations, jsonDocuments, jsonDocumentsAt, lineAt, xmlAttributes, xmlText } from "../util.js";
import { joinSources, withSource } from "../ownership.js";
// oxlint prints one run ten ways, and it chooses among them itself: a terminal gets a
// drawn report, a GitHub Actions job gets workflow annotations, an AI agent gets one line
// per finding. Only that last one was read. The report a developer sees and the
// annotations a CI job writes both came back with nothing, and so did -f json,
// checkstyle, gitlab, junit, sarif, stylish and unix.
//
// Every format names the rule the same way - the plugin, and the rule in brackets:
// `eslint(no-cond-assign)`. That is oxlint's own spelling (eslint writes `no-cond-assign`
// or `plugin/rule`), so wherever a format shares its shape with other tools, the rule is
// what makes a finding oxlint's. The rule is what you would disable; the plugin in front
// of it is not part of that name, so the code is the rule alone.
//
// A finding with no rule - a file that does not parse - is read only where the format
// names oxlint some other way, since the shape alone is also eslint's.
const RULE_RE = /^([\w-]+)\(([\w/-]+)\)$/;
const RULE = String.raw`([\w-]+)\(([\w/-]+)\)`;

// -f agent: `lintme.js:1:5: error eslint(no-unused-vars): Variable 'unused' is ... help: ...`
const FINDING_RE = /^(\S+?):(\d+):(\d+):[^\S\n]+(error|warning)[^\S\n]+(?:([\w-]+)\()?([\w-]+)\)?:[^\S\n]*(.+?)[^\S\n]*$/;
// "... help: Consider removing this declaration." - advice, not what happened.
const HELP_RE = /[^\S\n]*\bhelp:[^\S\n].*$/;
// The two lines every drawn report ends with, the second of which no other tool writes.
const TALLY_LINE_RE = /^Found \d+ warnings? and \d+ errors?\.[^\S\n]*$/;
const FINISHED_LINE_RE = /^Finished in [\d.]+\S*s on \d+ files? with \d+ rules using \d+ threads\.[^\S\n]*$/;
// What a drawn report is made of between one heading and the next: the source it quotes
// (` 3 | if (amount = 0) {`), the marks under it (`:` or `·`), the box's closing line,
// the advice, and blank lines.
const DRAWN_BODY_RE = /^[^\S\n]*(?:$|\d+[^\S\n]*[|\u2502]|[:\u00b7]|[`\u2570][-\u2500]+|help:)/;

// -f default, drawn the way miette draws: a severity glyph, the rule and the message, then
// the location on the very next line. A terminal gets `×`, `⚠` and `╭─[`; a pipe gets
// `x`, `!` and `,-[`.
//
//   x eslint(no-cond-assign): Expected a conditional expression and instead saw an assignment
//    ,-[src/checkout.js:3:14]
const DRAWN_HEAD_RE = new RegExp(String.raw`^[^\S\n]*(x|!|\u00d7|\u26a0)[^\S\n]+(?:${RULE}:[^\S\n]+)?(\S.*?)[^\S\n]*$`);
const DRAWN_AT_RE = /^[^\S\n]*(?:,-|\u256d\u2500)\[(.+):(\d+):(\d+)\][^\S\n]*$/;

/** For each line, whether a drawn diagnostic heading just above it is part of an oxlint
 *  report: every line from there down to oxlint's closing tally is a line of a drawn
 *  report. swc draws exactly the same box around a syntax error, so in a log holding
 *  both, "the log ends the way oxlint's does" was not enough to make swc's error oxlint's.
 *
 *  Asked by walking down from each heading, a report of thousands of findings with no
 *  rule name - parse errors - walked the rest of the report once per finding. The answer
 *  from a line is the answer from the line below it until a tally or a line that is not
 *  drawn decides it, so it is worked out once, from the bottom. */
function reportsBelow(lines) {
  const verdict = new Array(lines.length + 1).fill(false);
  for (let j = lines.length - 1; j >= 0; j--) {
    if (TALLY_LINE_RE.test(lines[j])) verdict[j] = FINISHED_LINE_RE.test(lines[j + 1] ?? "");
    else if (!DRAWN_HEAD_RE.test(lines[j]) && !DRAWN_AT_RE.test(lines[j]) && !DRAWN_BODY_RE.test(lines[j])) verdict[j] = false;
    else verdict[j] = verdict[j + 1];
  }
  return verdict;
}

// -f unix: `src/cart.js:2:1: `debugger` statement is not allowed [Error/eslint(no-debugger)]`
const UNIX_RE = new RegExp(String.raw`^(\S+?):(\d+):(\d+):[^\S\n]+(.+?)[^\S\n]+\[(Error|Warning)\/${RULE}\][^\S\n]*$`);

// -f stylish, which is eslint's table with oxlint's rule at the end of each row:
//
//   /app/src/cart.js
//     2:1   error  `debugger` statement is not allowed  eslint(no-debugger)
const STYLISH_ROW_RE = new RegExp(String.raw`^[^\S\n]+(\d+):(\d+)[^\S\n]+(error|warning)[^\S\n]+(.+?)[^\S\n]{2,}${RULE}[^\S\n]*$`);
const STYLISH_FILE_RE = /^(\S.*?)[^\S\n]*$/;

// -f json: `{ "diagnostics": [...], "number_of_files": 2, "number_of_rules": 97, ... }`
const JSON_MARK = (v) => !!v && typeof v === "object" && Array.isArray(v.diagnostics) &&
  Number.isInteger(v.number_of_files) && Number.isInteger(v.number_of_rules);

// -f checkstyle and -f gitlab are shapes other linters write, so a finding in them is
// oxlint's by its rule.
const CHECKSTYLE_FILE_RE = /<file\b([^>]*)>([\s\S]*?)<\/file>/dg;
const CHECKSTYLE_ERROR_RE = /<error\b([^>]*?)\/?>/g;
const GITLAB_MARK = (v) => Array.isArray(v) && v.length > 0 && v.every((d) =>
  d && typeof d.check_name === "string" && typeof d.fingerprint === "string" &&
  typeof d.location?.path === "string") && v.some((d) => RULE_RE.test(d.check_name));

// -f junit names itself on the document. A warning is written as a <failure> and an
// error as an <error>, and the body says where: `line 2, column 1, <message>`.
const JUNIT_DOC_RE = /<testsuites\b[^>]*\bname="Oxlint"[^>]*>([\s\S]*?)<\/testsuites>/dg;
const JUNIT_SUITE_RE = /<testsuite\b([^>]*)>([\s\S]*?)<\/testsuite>/dg;
const JUNIT_CASE_RE = /<testcase\b([^>]*)>([\s\S]*?)<\/testcase>/g;
const JUNIT_OUTCOME_RE = /<(error|failure)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/;
const CHECKSTYLE_FILE = { open: /<file\b/, close: () => "</file>" };
const JUNIT_DOC = { open: /<testsuites\b/, close: () => "</testsuites>" };
const JUNIT_SUITE = { open: /<testsuite\b/, close: () => "</testsuite>" };
const JUNIT_CASE = { open: /<testcase\b/, close: () => "</testcase>" };
const JUNIT_OUTCOME = { open: /<(error|failure)\b/, close: (name) => `</${name}>`, selfClosing: true };
const JUNIT_WHERE_RE = /^line (\d+), column (\d+),/;

// -f sarif names its driver.
const SARIF_MARK = (v) => !!v && typeof v === "object" && Array.isArray(v.runs) &&
  v.runs.some((run) => run?.tool?.driver?.name === "oxlint" && Array.isArray(run.results));

const rule = (text) => String(text ?? "").match(RULE_RE)?.[2];
const positive = (n) => (Number.isInteger(+n) && +n > 0 ? +n : undefined);

/** Every finding in `s`, errors and warnings, in whichever formats it holds - each with
 *  the lines [from, to) it was read from when `placed`, which reading a report for them
 *  costs and deciding whether to claim it does not need. */
function findings(s, placed = false) {
  const lines = s.split("\n");
  const out = [];
  const documents = (mark) => (placed ? [...jsonDocumentsAt(s, mark)]
    : [...jsonDocuments(s, mark)].map((value) => ({ value, where: () => ({ start: 0, end: 1 }) })));
  const inText = (at, length) => ({ from: lineAt(s, at), to: lineAt(s, at + length - 1) + 1 });
  let stylishFile, reports;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const agent = line.match(FINDING_RE);
    if (agent) {
      out.push({ file: agent[1], line: +agent[2], col: +agent[3], severity: agent[4], code: agent[6],
        message: agent[7].replace(HELP_RE, "").trim(), from: i, to: i + 1 });
      continue;
    }
    const unix = line.match(UNIX_RE);
    if (unix) {
      out.push({ file: unix[1], line: +unix[2], col: +unix[3], severity: unix[5].toLowerCase(), code: unix[7],
        message: unix[4], from: i, to: i + 1 });
      continue;
    }
    const head = line.match(DRAWN_HEAD_RE);
    const at = head && lines[i + 1]?.match(DRAWN_AT_RE);
    if (at && (head[3] || (reports ??= reportsBelow(lines))[i + 1])) {
      // The heading, the location under it, and the box drawn below them.
      let to = i + 2;
      for (let j = i + 2; j < lines.length && DRAWN_BODY_RE.test(lines[j]) && !DRAWN_HEAD_RE.test(lines[j]); j++) {
        if (lines[j].trim()) to = j + 1;
      }
      out.push({ file: at[1], line: +at[2], col: +at[3],
        severity: head[1] === "x" || head[1] === "\u00d7" ? "error" : "warning", code: head[3], message: head[4], from: i, to });
      i++;
      continue;
    }
    const row = line.match(STYLISH_ROW_RE);
    if (row && stylishFile) {
      out.push({ file: stylishFile, line: +row[1], col: +row[2], severity: row[3], code: row[6], message: row[4], from: i, to: i + 1 });
      continue;
    }
    // A table row belongs to the last unindented line above it.
    if (line.trim() && !/^[^\S\n]/.test(line)) stylishFile = line.match(STYLISH_FILE_RE)?.[1];
  }

  if (/^[^\S\n]*::(?:error|warning)[^\S\n]/m.test(s)) {
    for (const a of githubAnnotations(s)) {
      const code = rule(a.props.title);
      if ((!code && a.props.title !== "oxlint") || !a.props.file) continue;
      // oxlint says the position a second time at the start of the message.
      const said = `${a.props.file}:${a.props.line}:${a.props.col}: `;
      if (!a.message.startsWith(said)) continue;
      out.push({ file: a.props.file, line: positive(a.props.line), col: positive(a.props.col),
        severity: a.severity === "error" ? "error" : "warning", code, message: a.message.slice(said.length).trim(),
        from: a.line, to: a.line + 1 });
    }
  }

  const docs = s.includes('"number_of_rules"') ? documents(JSON_MARK) : [];
  for (const { value, where } of docs) {
    for (const d of value.diagnostics) {
      const span = d?.labels?.[0]?.span;
      if (typeof d?.filename !== "string" || typeof d.message !== "string") continue;
      const { start, end } = where(d);
      out.push({ file: d.filename, line: positive(span?.line), col: positive(span?.column),
        severity: d.severity === "error" ? "error" : "warning", code: rule(d.code), message: d.message.trim(), from: start, to: end });
    }
  }

  if (s.includes("<checkstyle")) {
    for (const f of elements(s, CHECKSTYLE_FILE_RE, CHECKSTYLE_FILE)) {
      const file = xmlAttributes(f[1]).name;
      for (const e of f[2].matchAll(CHECKSTYLE_ERROR_RE)) {
        const a = xmlAttributes(e[1]);
        const code = rule(a.source);
        if (!code || !file) continue;
        out.push({ file, line: positive(a.line), col: positive(a.column),
          severity: a.severity === "error" ? "error" : "warning", code, message: String(a.message ?? "").trim(),
          ...inText(f.indices[2][0] + e.index, e[0].length) });
      }
    }
  }

  for (const { value, where } of s.includes('"check_name"') ? documents(GITLAB_MARK) : []) {
    for (const d of value) {
      const code = rule(d.check_name);
      if (!code) continue;
      const { start, end } = where(d);
      out.push({ file: d.location.path, line: positive(d.location.lines?.begin),
        // GitLab's own scale, onto which oxlint writes an error as critical and a warning
        // as major. The format has nowhere to put a column.
        severity: d.severity === "critical" || d.severity === "blocker" ? "error" : "warning",
        code, message: String(d.description ?? "").trim(), from: start, to: end });
    }
  }

  if (s.includes('name="Oxlint"')) {
    for (const doc of elements(s, JUNIT_DOC_RE, JUNIT_DOC)) {
      for (const suite of elements(doc[1], JUNIT_SUITE_RE, JUNIT_SUITE)) {
        const file = xmlAttributes(suite[1]).name;
        for (const test of elements(suite[2], JUNIT_CASE_RE, JUNIT_CASE)) {
          const outcome = firstElement(test[2], JUNIT_OUTCOME_RE, JUNIT_OUTCOME);
          if (!outcome || !file) continue;
          const where = xmlText(outcome[3] ?? "").trim().match(JUNIT_WHERE_RE);
          // The test case, from its opening tag to its closing one.
          out.push({ file, line: positive(where?.[1]), col: positive(where?.[2]),
            severity: outcome[1] === "error" ? "error" : "warning", code: rule(xmlAttributes(test[1]).name),
            message: String(xmlAttributes(outcome[2]).message ?? "").trim(),
            ...inText(doc.indices[1][0] + suite.indices[2][0] + test.index, test[0].length) });
        }
      }
    }
  }

  const sarif = s.includes('"oxlint"') ? documents(SARIF_MARK) : [];
  for (const { value, where: placeOf } of sarif) {
    for (const run of value.runs.filter((r) => r?.tool?.driver?.name === "oxlint")) {
      for (const r of run.results ?? []) {
        const where = r?.locations?.[0]?.physicalLocation;
        if (typeof where?.artifactLocation?.uri !== "string") continue;
        const { start, end } = placeOf(r);
        out.push({ file: where.artifactLocation.uri, line: positive(where.region?.startLine),
          col: positive(where.region?.startColumn), severity: r.level === "error" ? "error" : "warning",
          // A file that does not parse is given an id of oxlint's own, `OXL0001`, where the
          // other formats give none; it is not a rule you could disable.
          code: rule(r.ruleId), message: String(r.message?.text ?? "").trim(), from: start, to: end });
      }
    }
  }
  return out;
}

export default {
  name: "oxlint",
  category: "lint",
  commands: ["oxlint"],

  detect: (s) => findings(s).length > 0,

  extract(s) {
    const failures = [];
    const seen = new Map(), warned = new Set();
    for (const f of findings(s, true)) {
      const key = [f.file, f.line, f.col, f.code, f.message].join("\u0000");
      if (f.severity !== "error") { warned.add(key); continue; }
      const failure = withSource({
        file: f.file, line: f.line, col: f.col,
        title: f.code ?? "error", ...(f.code ? { code: f.code } : { label: "error" }),
        severity: "error", message: f.message,
      }, f.from, f.to);
      // One run printed in two formats is one finding, read in both places.
      if (seen.has(key)) { failures[seen.get(key)] = joinSources(failures[seen.get(key)], failure); continue; }
      seen.set(key, failures.length);
      failures.push(failure);
    }
    if (!failures.length) return null;
    const n = failures.length, w = warned.size;
    return {
      tool: "oxlint",
      summary: `${n} error${n === 1 ? "" : "s"}` + (w ? ` — ${w} warning${w === 1 ? "" : "s"} hidden` : ""),
      failures,
    };
  },
};
