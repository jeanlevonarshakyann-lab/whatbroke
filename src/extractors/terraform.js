// Terraform draws each diagnostic in a box, and everything inside it is prefixed with a
// vertical bar that is part of the drawing rather than the message:
//
//   ╷
//   │ Error: Missing required argument
//   │
//   │   on main.tf line 1, in resource "local_file" "demo":
//   │    1: resource "local_file" "demo" {
//   │
//   │ The argument "filename" is required, but no definition was found.
//   ╵
//
// Read as prose that comes to "│ Error: Missing required argument" and nothing else -
// no file, no line, and not the sentence at the bottom that says what to do about it.
import { withSource } from "../ownership.js";

const BAR = /^[^\S\n]*[│|][^\S\n]?/;
const HEAD_RE = /^[^\S\n]*[│|][^\S\n]*(Error|Warning):[^\S\n]*(.*)$/;
const AT_RE = /^[^\S\n]*on[^\S\n]+(\S+)[^\S\n]+line[^\S\n]+(\d+)(?:,[^\S\n]+in[^\S\n]+(.+?))?:[^\S\n]*$/;
const SRC_RE = /^[^\S\n]*\d+:[^\S\n]?(.*)$/;
const CLOSE_RE = /^[^\S\n]*[╵╷][^\S\n]*$/;
const MAX_MESSAGE = 4;

// `terraform init` does not draw a box. It writes the error flat, with the explanation
// indented under it and no location at all, because nothing has been parsed yet:
//
//   Initializing provider plugins...
//   Error: Invalid provider registry host
//   The host "example.com" given in provider source address ... does not offer a
//   Terraform provider registry.
//
// "Error: <anything>" is every tool's shape, so what identifies this one is the banner
// terraform prints above it. Without this branch a failed `init` - the first command
// anyone runs, and the one that fails on a bad provider or an unreachable backend -
// came back as a guess.
const INIT_BANNER_RE = /^[^\S\n]*Initializing (?:the backend|provider plugins|modules)\b/m;
const FLAT_HEAD_RE = /^(Error|Warning):[^\S\n]*(.*)$/;

// Candidates nested inside this many others are not parsed. A document that parses as
// JSON but is not a report would otherwise be parsed again from every line inside it
// that opens a brace near a schema identifier.
const MAX_NESTING = 32;

/** Terraform's `validate -json` document(s), even when another tool wrote beside it.
 *
 *  A document starts on a line that opens a brace with the schema identifier within its
 *  first lines, and ends on the first line after which its braces balance. Found by
 *  counting from each such line, a log repeating the first two lines of a report counted
 *  to the end of the log once per repetition. The count from any line is the running
 *  total from the top of the log less what it was at that line, so where it first comes
 *  back down is looked up rather than counted. A document never carries a string across
 *  a line - JSON has no raw newline in a string - so every line is counted from outside
 *  a string, and a line that ends inside one is one no document can pass. */
function jsonReports(text) {
  if (!text.includes('"format_version"')) return [];
  const lines = text.split("\n");
  const n = lines.length;
  const depth = new Float64Array(n + 1);          // braces open before line k, counted from the top
  const quoted = new Int32Array(n + 1).fill(n);   // the first line at or after k that ends in a string
  for (let k = 0; k < n; k++) {
    let open = 0, inString = false, escaped = false;
    for (const char of lines[k]) {
      if (escaped) { escaped = false; continue; }
      if (inString && char === "\\") { escaped = true; continue; }
      if (char === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (char === "{") open++;
      else if (char === "}") open--;
    }
    depth[k + 1] = depth[k] + open;
    if (inString || escaped) quoted[k] = k;
  }
  for (let k = n - 1; k >= 0; k--) if (quoted[k] === n) quoted[k] = quoted[k + 1];
  // closes[k]: the first index after k whose count is at or below k's - so the line a
  // document opened on line k balances on is closes[k] - 1, if there is one.
  const closes = new Int32Array(n + 1).fill(n + 1);
  const lower = [];
  for (let k = n; k >= 0; k--) {
    while (lower.length && depth[lower[lower.length - 1]] > depth[k]) lower.pop();
    if (lower.length) closes[k] = lower[lower.length - 1];
    lower.push(k);
  }
  const reports = [];
  const around = [];                              // the candidates this line is inside
  for (let i = 0; i < n; i++) {
    if (!lines[i].trimStart().startsWith("{")) continue;
    // Do not balance every source-code brace in a mixed build. The schema identifier
    // is always at the document's top, and checking this small window bounds the work.
    if (!lines.slice(i, i + 5).join("\n").includes('"format_version"')) continue;
    if (closes[i] > n) continue;
    const j = closes[i] - 1;
    if (quoted[i] <= j || depth[j + 1] < depth[i]) continue;
    while (around.length && around[around.length - 1] < i) around.pop();
    if (around.length >= MAX_NESTING) continue;
    around.push(j);
    let value;
    try { value = JSON.parse(lines.slice(i, j + 1).join("\n").trim()); }
    catch { continue; }
    if (value && typeof value === "object" && typeof value.format_version === "string" &&
        typeof value.valid === "boolean" && Number.isInteger(value.error_count) &&
        Number.isInteger(value.warning_count) && Array.isArray(value.diagnostics)) {
      reports.push({ value, start: i, end: j + 1 });
      i = j;
    }
  }
  return reports;
}

/** Diagnostic events from Terraform's newline-delimited `plan -json` UI stream. */
function jsonEvents(text) {
  const events = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    // Parse only Terraform diagnostic candidates. A mixed machine log may contain
    // thousands of JSON events from other tools, and none should become ours merely
    // because it has a `diagnostic` property.
    if (!line.startsWith("{") || !line.endsWith("}") ||
        !/"@module"\s*:\s*"terraform\.ui"/.test(line) ||
        !/"type"\s*:\s*"diagnostic"/.test(line)) continue;
    let value;
    try { value = JSON.parse(line); } catch { continue; }
    const diagnostic = value?.diagnostic;
    if (value?.["@module"] !== "terraform.ui" || value?.type !== "diagnostic" ||
        !diagnostic || typeof diagnostic !== "object") continue;
    events.push({ value: { diagnostics: [diagnostic] }, start: i, end: i + 1 });
  }
  return events;
}

function jsonDiagnostics(text) {
  const failures = [];
  let warnings = 0;
  for (const report of [...jsonReports(text), ...jsonEvents(text)]) {
    for (const diagnostic of report.value.diagnostics) {
      if (!diagnostic || typeof diagnostic.summary !== "string") continue;
      if (diagnostic.severity === "warning") { warnings++; continue; }
      if (diagnostic.severity !== "error") continue;
      const range = diagnostic.range;
      const start = range?.start;
      const snippet = diagnostic.snippet;
      const snippetLine = Number.isInteger(start?.line) && Number.isInteger(snippet?.start_line)
        ? String(snippet.code ?? "").split("\n")[start.line - snippet.start_line]
        : undefined;
      // One JSON document is the raw region that supports every diagnostic it carries.
      failures.push(withSource({
        file: range?.filename, line: start?.line, col: start?.column,
        title: diagnostic.summary, subject: snippet?.context, severity: "error",
        message: typeof diagnostic.detail === "string" && diagnostic.detail.trim()
          ? diagnostic.detail.trim() : diagnostic.summary,
        ...(snippetLine?.trim() ? { stmt: snippetLine.trim() } : {}),
      }, report.start, report.end));
    }
  }
  return { failures, warnings };
}

/** `terraform validate -no-color` omits the box on current Terraform releases. */
function flatValidateDiagnostics(text) {
  const lines = text.split("\n");
  const failures = [];
  let warnings = 0;
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i].match(FLAT_HEAD_RE);
    if (!head) continue;
    let file, line, subject, stmt, end = i + 1;
    const detail = [];
    for (let j = i + 1; j < lines.length && j <= i + 16; j++) {
      if (FLAT_HEAD_RE.test(lines[j])) break;
      const inner = lines[j].trim();
      // A blank after the prose ends this diagnostic. Without this boundary, the first
      // lines of whatever command ran next were appended to Terraform's message in a
      // mixed CI log, changing the failure even though its count happened to agree.
      if (!inner && detail.length) break;
      const at = inner.match(AT_RE);
      if (at) { file ??= at[1]; line ??= +at[2]; subject ??= at[3]; end = j + 1; continue; }
      const source = inner.match(SRC_RE);
      if (source) {
        if (+inner.slice(0, inner.indexOf(":")) === line) stmt ??= source[1].trim();
        end = j + 1;
        continue;
      }
      if (file && inner && detail.length < MAX_MESSAGE) { detail.push(inner); end = j + 1; }
    }
    // `Error:` is universal. The nearby Terraform location is what owns this form.
    if (!file || !/\.tf(?:\.json)?$/.test(file) || !line) continue;
    if (head[1] === "Warning") { warnings++; continue; }
    // The header, its location, the source it quotes and the prose under it.
    failures.push(withSource({
      file, line, title: head[2].trim(), subject, severity: "error",
      message: detail.length ? detail.join("\n") : head[2].trim(), stmt,
    }, i, end));
  }
  return { failures, warnings };
}

export default {
  name: "terraform",
  category: "build",
  commands: ["terraform", "tofu", "terragrunt"],

  detect: (s) =>
    jsonReports(s).length > 0 || jsonEvents(s).length > 0 ||
    (HEAD_RE.test(s.split("\n").find((l) => HEAD_RE.test(l)) ?? "") &&
      (/^[^\S\n]*╷[^\S\n]*$/m.test(s) || /[^\S\n]on[^\S\n]+\S+[^\S\n]+line[^\S\n]+\d+/.test(s))) ||
    flatValidateDiagnostics(s).failures.length > 0 ||
    (INIT_BANNER_RE.test(s) && s.split("\n").some((l) => FLAT_HEAD_RE.test(l))),

  extract(s) {
    const lines = s.split("\n");
    const json = jsonDiagnostics(s);
    const flat = flatValidateDiagnostics(s);
    const failures = [...json.failures, ...flat.failures];
    let warnings = json.warnings + flat.warnings;
    for (let i = 0; i < lines.length; i++) {
      const h = lines[i].match(HEAD_RE);
      if (!h) continue;
      let file, line, block, stmt, end = i + 1;
      const message = [];
      for (let j = i + 1; j < lines.length; j++) {
        if (CLOSE_RE.test(lines[j]) || HEAD_RE.test(lines[j])) break;
        if (!BAR.test(lines[j])) break;
        end = j + 1;
        const inner = lines[j].replace(BAR, "").trimEnd();
        const at = inner.match(AT_RE);
        if (at) { file ??= at[1]; line ??= +at[2]; block ??= at[3]; continue; }
        const src = inner.match(SRC_RE);
        if (src) { stmt ??= src[1].trim(); continue; }
        if (inner.trim() && message.length < MAX_MESSAGE) message.push(inner.trim());
      }
      if (h[1] !== "Error") { warnings++; continue; }
      // The boxed diagnostic, from its header down to the box's last line.
      failures.push(withSource({
        file, line, title: h[2], subject: block, severity: "error",
        // The headline is already the title; repeating it as the first line of the
        // message says it twice. The prose underneath is what it did not say.
        message: (message.length ? message : [h[2]]).join("\n"), stmt,
      }, i, end));
    }
    if (!failures.length && INIT_BANNER_RE.test(s)) {
      // Bounded to the window after terraform's own banner. init says what it is doing
      // and then why it stopped, so its errors sit directly under the last "Initializing
      // ..." or "- Finding ..." line it wrote. Scanning the whole log for "Error: " -
      // which is every tool's shape - had terraform claiming Go's expected-error strings
      // out of a test log, fifteen of them.
      // Not a window - the very next thing it says. init narrates what it is doing and
      // then why it stopped, so the error is the first non-blank line after the last
      // step. A window of a dozen lines still reached past terraform's own output into
      // whatever followed it, and took sass's "Error: Undefined variable." with it.
      const INIT_STEP_RE = /^[^\S\n]*(?:Initializing |- (?:Finding|Installing|Using|Downloading) )/;
      let last = -1;
      for (let i = 0; i < lines.length; i++) if (INIT_STEP_RE.test(lines[i])) last = i;
      let stop = last;
      for (let i = last + 1; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        stop = i;   // the first thing said after the narration, whatever it is
        break;
      }
      // The flat form. The prose under the header is the explanation; a blank line or
      // the next header ends it, and there is no location to find because init runs
      // before anything has been parsed.
      for (let i = stop; i <= stop && i >= 0 && i < lines.length; i++) {
        const h = lines[i].match(FLAT_HEAD_RE);
        if (!h) continue;
        // A blank line separates the header from the prose, so it cannot end it - but a
        // blank AFTER the prose has started does.
        const prose = [];
        let end = i + 1;
        for (let j = i + 1; j < lines.length && j <= i + 8 && prose.length < MAX_MESSAGE; j++) {
          if (FLAT_HEAD_RE.test(lines[j])) break;
          if (!lines[j].trim()) { if (prose.length) break; else continue; }
          prose.push(lines[j].trim());
          end = j + 1;
        }
        if (h[1] === "Warning") { warnings++; continue; }
        failures.push(withSource({
          title: h[2].trim(), label: h[2].trim(), severity: "error",
          message: prose.length ? prose.join(" ") : h[2].trim(),
        }, i, end));
      }
    }
    if (!failures.length) return null;
    const n = failures.length;
    return {
      tool: "terraform",
      summary: `${n} error${n > 1 ? "s" : ""}` +
        (warnings ? ` — ${warnings} warning${warnings > 1 ? "s" : ""} hidden` : ""),
      failures,
    };
  },
};
