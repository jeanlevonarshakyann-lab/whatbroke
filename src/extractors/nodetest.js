// `node --test` emits TAP with a YAML diagnostic block per failure:
//
//   not ok 59 - rate-limit events fire only once per transition
//     ---
//     location: '/path/test/advanced.ts:1:32121'
//     failureType: 'testCodeFailure'
//     error: |-
//       Expected values to be strictly equal:
//
//       2 !== 1
//     name: 'AssertionError'
//     ...
//
// Everything worth showing is in there; the trick is that `error: |-` is a YAML
// block scalar, so its content is the following lines indented one level deeper.
import { isNoise } from "../util.js";
import { SOURCE_RANGE } from "../ownership.js";

const NOT_OK_RE = /^([^\S\n]*)not ok[^\S\n]+\d+[^\S\n]+-[^\S\n]+(.+?)[^\S\n]*$/;
const SUBTEST_RE = /^([^\S\n]*)# Subtest:\s/;
const FAILURE_TYPE_RE = /^[^\S\n]*failureType:[^\S\n]*'(.+?)'[^\S\n]*$/;
const LOCATION_RE = /^[^\S\n]*location:[^\S\n]*'(.+?):(\d+):(\d+)'[^\S\n]*$/;
const NAME_RE = /^[^\S\n]*name:[^\S\n]*'(.+?)'[^\S\n]*$/;
const ERROR_RE = /^([^\S\n]*)error:[^\S\n]*\|-?[^\S\n]*$/;
const ERROR_INLINE_RE = /^[^\S\n]*error:[^\S\n]*'?(.+?)'?[^\S\n]*$/;
const KEY_RE = /^[^\S\n]*[a-zA-Z_]+:\s/;
const MAX_MESSAGE_LINES = 4;
const ALT_FAILURE_RE = /^✖[^\S\n]+(.+?)(?:[^\S\n]+\([\d.]+ms\))?[^\S\n]*$/;
const ALT_LOCATION_RE = /^(?:test|suite)[^\S\n]+at[^\S\n]+(.+?):(\d+):(\d+)[^\S\n]*$/;

const unfile = (path) => path?.startsWith("file://")
  ? decodeURIComponent(path.slice(7))
  : path;

function xmlText(value) {
  return String(value).replace(/&(?:quot|apos|lt|gt|amp);/g,
    (entity) => ({ "&quot;": '"', "&apos;": "'", "&lt;": "<", "&gt;": ">", "&amp;": "&" })[entity]);
}

function xmlAttributes(tag) {
  const attributes = {};
  for (const match of tag.matchAll(/([\w:.-]+)="([^"]*)"/g)) attributes[match[1]] = xmlText(match[2]);
  return attributes;
}

function userFrame(lines, start, end) {
  const frames = [];
  for (let i = start; i < end; i++) {
    const decoded = xmlText(lines[i]);
    const frame = decoded.match(/(?:\(|[^\S\n])((?:file:\/\/)?[^()\s]+?):(\d+):(\d+)\)?[^\S\n]*$/);
    if (!frame) continue;
    const location = { file: unfile(frame[1]), line: +frame[2], col: +frame[3] };
    frames.push(location);
  }
  return frames.find((frame) => !isNoise(frame.file)) ?? frames[0];
}

function alternateMessage(lines, start, end) {
  for (let i = start; i < end; i++) {
    const text = xmlText(lines[i]).trim();
    const error = text.match(/^(?:cause:[^\S\n]*)?((?:[A-Z]\w*)?(?:Error|Exception))(?:[^\S\n]+\[[\w_]+\])?:[^\S\n]*(.*)$/);
    if (!error) continue;
    const message = [`${error[1]}: ${error[2]}`.trimEnd()];
    for (let j = i + 1; j < end && message.length < MAX_MESSAGE_LINES; j++) {
      const detail = xmlText(lines[j]).trim();
      if (!detail) continue;
      if (/^at[^\S\n]/.test(detail) || /^\][^\S\n]*\{$/.test(detail) || /^\}$/.test(detail)) break;
      if (/^(?:generatedMessage|code|actual|expected|operator|diff|failureType):/.test(detail)) continue;
      message.push(detail);
    }
    return message.join("\n");
  }
  return "test failed";
}

function rangedFailure(failure, start, end) {
  Object.defineProperty(failure, SOURCE_RANGE, { value: { start, end }, enumerable: false });
  return failure;
}

const FILE_TITLE_RE = /\.(?:[cm]?[jt]sx?)$/i;

function sameFile(left, right) {
  const clean = (value) => unfile(String(value ?? "")).replace(/\\/g, "/");
  const a = clean(left), b = clean(right);
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

/** Spec keeps a crashed file's real exception above its terse `test failed` roll-up. */
function runtimeCause(lines, target, before) {
  const errorRe = /^(?:Uncaught[^\S\n]+)?((?:[A-Z]\w*)?(?:Error|Exception)(?:[^\S\n]+\[[\w_]+\])?):[^\S\n]*(.*)$/;
  for (let i = before - 1; i >= 0; i--) {
    const error = lines[i].match(errorRe);
    if (!error) continue;
    const frame = userFrame(lines, i + 1, Math.min(before, i + 14));
    let location = frame && !isNoise(frame.file) ? frame : null;
    let stmt, start = i;
    for (let j = i - 1; j >= 0 && j >= i - 5; j--) {
      if (!/^[^\S\n]*\^+[^\S\n]*$/.test(lines[j])) continue;
      const header = lines[j - 2]?.match(/^(\S+):(\d+)$/);
      if (!header || !sameFile(header[1], target)) continue;
      if (!location || !sameFile(location.file, target)) {
        location = { file: unfile(header[1]), line: +header[2] };
      }
      stmt = lines[j - 1]?.trim();
      start = j - 2;
      break;
    }
    if (!location || !sameFile(location.file, target)) continue;
    return {
      ...location, stmt, message: `${error[1]}: ${error[2]}`.trimEnd(),
      start, end: Math.min(before, i + 2),
    };
  }
  return null;
}

function nodeSpec(text) {
  if (!/^✖[^\S\n]+failing tests:[^\S\n]*$/m.test(text) || !/^ℹ[^\S\n]+fail[^\S\n]+\d+[^\S\n]*$/m.test(text)) {
    return { failures: [], failed: 0, passed: 0 };
  }
  const lines = text.split("\n");
  const section = lines.findIndex((line) => /^✖[^\S\n]+failing tests:[^\S\n]*$/.test(line));
  const failures = [];
  for (let i = section + 1; i < lines.length; i++) {
    const location = lines[i].match(ALT_LOCATION_RE);
    if (!location) continue;
    let at = i + 1;
    while (at < lines.length && !lines[at].trim()) at++;
    const heading = lines[at]?.match(ALT_FAILURE_RE);
    if (!heading) continue;
    let first = at + 1;
    while (first < lines.length && !lines[first].trim()) first++;
    if (/^['"]test failed['"]$/.test(lines[first]?.trim())) {
      const cause = runtimeCause(lines, location[1], section);
      failures.push(rangedFailure({
        file: cause?.file ?? location[1], line: cause?.line ?? +location[2],
        col: cause?.col ?? +location[3], ...(cause?.stmt ? { stmt: cause.stmt } : {}),
        title: heading[1], subject: heading[1], severity: "error",
        message: cause?.message ?? "test failed",
      }, cause?.start ?? i, cause?.end ?? Math.min(first + 1, lines.length)));
      i = first;
      continue;
    }
    let end = at + 1;
    while (end < lines.length && !ALT_LOCATION_RE.test(lines[end])) end++;
    const terse = alternateMessage(lines, at + 1, end);
    failures.push(rangedFailure({
      file: location[1], line: +location[2], col: +location[3],
      title: heading[1], subject: heading[1], severity: "error",
      message: terse,
    }, i, end));
    i = end - 1;
  }
  const count = (kind) => [...text.matchAll(new RegExp(String.raw`^ℹ[^\S\n]+${kind}[^\S\n]+(\d+)[^\S\n]*$`, "gm"))]
    .reduce((total, match) => total + Number(match[1]), 0);
  return { failures, failed: count("fail"), passed: count("pass") };
}

function nodeDot(text) {
  if (!/^Failed tests:[^\S\n]*$/m.test(text)) return { failures: [], failed: 0, passed: 0 };
  const lines = text.split("\n");
  const section = lines.findIndex((line) => /^Failed tests:[^\S\n]*$/.test(line));
  const failures = [];
  for (let i = section + 1; i < lines.length; i++) {
    const heading = lines[i].match(ALT_FAILURE_RE);
    if (!heading) continue;
    let first = i + 1;
    while (first < lines.length && !lines[first].trim()) first++;
    const opaqueFile = FILE_TITLE_RE.test(heading[1]) && /^['"]test failed['"]$/.test(lines[first]?.trim())
      ? heading[1]
      : null;
    // A file that crashes before registering tests is all dot preserves: its path and
    // this one opaque line. Bound it immediately. Looking for a stack beyond that line
    // lets the next tool in a combined CI log change or erase this diagnosis.
    if (opaqueFile) {
      failures.push(rangedFailure({
        file: opaqueFile, title: heading[1], subject: heading[1], severity: "error",
        message: "test failed",
      }, i, Math.min(first + 1, lines.length)));
      i = first;
      continue;
    }
    let end = i + 1;
    while (end < lines.length && !ALT_FAILURE_RE.test(lines[end])) end++;
    const location = userFrame(lines, i + 1, end);
    const message = alternateMessage(lines, i + 1, end);
    // Other tools use the same cross for their final tally. A Node dot failure always
    // carries its exception and stack beneath the heading; the tally does not.
    if (!location || message === "test failed") { i = end - 1; continue; }
    failures.push(rangedFailure({
      file: location.file, line: location.line, col: location.col,
      title: heading[1], subject: heading[1], severity: "error",
      message,
    }, i, end));
    i = end - 1;
  }
  return { failures, failed: failures.length, passed: 0 };
}

function nodeJunit(text) {
  const lines = text.split("\n");
  const failures = [];
  let failed = 0, passed = 0;
  for (let rootAt = 0; rootAt < lines.length; rootAt++) {
    if (!/<testsuites>/.test(lines[rootAt])) continue;
    let rootEnd = rootAt + 1;
    while (rootEnd < lines.length && !/<\/testsuites>/.test(lines[rootEnd])) rootEnd++;
    const document = lines.slice(rootAt, rootEnd + 1).join("\n");
    if (!/<failure[^>]+type="testCodeFailure"/.test(document) ||
        !/<!--[^\n]*\bfail[^\S\n]+\d+[^\S\n]*-->/.test(document)) {
      rootAt = rootEnd;
      continue;
    }
    for (let i = rootAt + 1; i < rootEnd; i++) {
      if (!/<testcase\b/.test(lines[i])) continue;
      if (/\/>[^\S\n]*$/.test(lines[i])) continue;
      const test = xmlAttributes(lines[i]);
      let testcaseEnd = i + 1;
      while (testcaseEnd < rootEnd && !/<\/testcase>/.test(lines[testcaseEnd])) testcaseEnd++;
      const failureAt = lines.findIndex((line, index) => index > i && index < testcaseEnd && /<failure\b/.test(line));
      if (failureAt < 0) { i = testcaseEnd; continue; }
      let failureEnd = failureAt + 1;
      while (failureEnd < testcaseEnd && !/<\/failure>/.test(lines[failureEnd])) failureEnd++;
      const location = userFrame(lines, failureAt + 1, failureEnd);
      const opaqueFile = !location && FILE_TITLE_RE.test(test.name ?? "") ? test.name : undefined;
      failures.push(rangedFailure({
        file: location?.file ?? opaqueFile, line: location?.line, col: location?.col,
        title: test.name || "test", subject: test.name || "test", severity: "error",
        message: alternateMessage(lines, failureAt + 1, failureEnd),
      }, i, Math.min(testcaseEnd + 1, lines.length)));
      i = testcaseEnd;
    }
    const count = (kind) => [...document.matchAll(new RegExp(String.raw`<!--[^\n]*\b${kind}[^\S\n]+(\d+)[^\S\n]*-->`, "g"))]
      .reduce((total, match) => total + Number(match[1]), 0);
    failed += count("fail");
    passed += count("pass");
    rootAt = rootEnd;
  }
  return { failures, failed, passed };
}

export default {
  name: "node --test",
  category: "test",
  commands: ["node"],
  detect: (s) =>
    (/^#[^\S\n]+fail[^\S\n]+\d+[^\S\n]*$/m.test(s) && /^[^\S\n]*not ok[^\S\n]+\d+[^\S\n]+-[^\S\n]+/m.test(s)) ||
    nodeSpec(s).failures.length > 0 || nodeJunit(s).failures.length > 0 || nodeDot(s).failures.length > 0,

  extract(s) {
    const alternateReports = [nodeSpec(s), nodeJunit(s), nodeDot(s)];
    const alternateFailures = alternateReports.flatMap((report) => report.failures);
    const lines = s.split("\n");
    const failures = [];
    // TAP prints a suite result after its children. Remember how many failures
    // preceded each scope so only parents with captured children are redundant.
    const scopeStarts = new Map();

    for (let i = 0; i < lines.length; i++) {
      const subtest = lines[i].match(SUBTEST_RE);
      if (subtest) scopeStarts.set(subtest[1].length, failures.length);
      const head = lines[i].match(NOT_OK_RE);
      if (!head) continue;

      let file, line, col, errName = "", failureType;
      const msg = [];
      for (let j = i + 1; j < lines.length && !NOT_OK_RE.test(lines[j]); j++) {
        if (/^[^\S\n]*\.\.\.[^\S\n]*$/.test(lines[j])) break;
        const type = lines[j].match(FAILURE_TYPE_RE);
        if (type) { failureType = type[1]; continue; }
        const loc = lines[j].match(LOCATION_RE);
        if (loc) { file = loc[1]; line = +loc[2]; col = +loc[3]; continue; }
        const nm = lines[j].match(NAME_RE);
        if (nm) { errName = nm[1]; continue; }

        const block = lines[j].match(ERROR_RE);
        if (block) {
          // a YAML block scalar: take the lines indented deeper than the key
          const indent = block[1].length;
          for (let k = j + 1; k < lines.length; k++) {
            const text = lines[k];
            const deeper = text.search(/\S/) > indent;
            if (!deeper && text.trim()) break;
            if (text.trim() && msg.length < MAX_MESSAGE_LINES) msg.push(text.trim());
            j = k;
          }
          continue;
        }
        if (!msg.length && ERROR_INLINE_RE.test(lines[j]) && !ERROR_RE.test(lines[j])) {
          msg.push(lines[j].match(ERROR_INLINE_RE)[1]);
          continue;
        }
        if (KEY_RE.test(lines[j])) continue;
      }

      // A block with none of node's own YAML keys is not node's. `tap` writes TAP 14
      // with the same "not ok N - name" line and an `at:` block instead of node's
      // `failureType` and `location`, so a log holding both had node reading tap's
      // failures - and tap's file-level roll-up with them, which is a count of failures
      // rather than one of its own.
      if (!failureType && file === undefined && !errName && !msg.length) continue;

      // "AssertionError: Expected values to be strictly equal:" reads better than
      // either half alone, and matches how every other parser here labels a failure
      const message = errName && msg.length && !msg[0].startsWith(errName)
        ? [`${errName}: ${msg[0]}`, ...msg.slice(1)].join("\n")
        : msg.join("\n");

      // "test failed" is node's own wording for a file that threw before declaring a
      // test, and it says nothing. What actually happened was printed to stderr above
      // the subtest, as TAP comments, and that is the only place it appears.
      let detail = message;
      if (/^(?:test failed|ERR_TEST_FAILURE)$/.test(message.trim())) {
        for (let k = i - 1; k >= 0 && k >= i - 60; k--) {
          const c = lines[k].match(/^#[^\S\n]+((?:[A-Z]\w*)?(?:Error|Exception)(?:[^\S\n]\[[\w_]+\])?: .+)$/);
          if (c) { detail = c[1]; break; }
          if (/^not ok /.test(lines[k])) break;   // a previous failure's block, not ours
        }
      }

      const start = scopeStarts.get(head[1].length);
      scopeStarts.delete(head[1].length);
      if (failureType === "subtestsFailed" && start !== undefined && failures.length > start) continue;
      failures.push({ file, line, col, title: head[2], subject: head[2], severity: "error", message: detail });
    }

    if (!failures.length && !alternateFailures.length) return null;

    const count = (k) => {
      const matches = [...s.matchAll(new RegExp(String.raw`^#[^\S\n]+${k}[^\S\n]+(\d+)[^\S\n]*$`, "gm"))];
      return matches.length ? matches.reduce((total, match) => total + Number(match[1]), 0) : null;
    };
    const [failed, passed] = [count("fail"), count("pass")];
    const alternateFailed = alternateReports
      .reduce((total, report) => total + Math.max(report.failed, report.failures.length), 0);
    const alternatePassed = alternateReports.reduce((total, report) => total + report.passed, 0);
    const totalFailed = (failed ?? failures.length) + alternateFailed;
    const totalPassed = (passed ?? 0) + alternatePassed;
    const bits = [];
    if (totalFailed) bits.push(`${totalFailed} failed`);
    if (totalPassed) bits.push(`${totalPassed} passed`);

    return {
      tool: "node --test", summary: bits.length ? bits.join(", ") : undefined,
      failures: [...failures, ...alternateFailures],
    };
  },
};
