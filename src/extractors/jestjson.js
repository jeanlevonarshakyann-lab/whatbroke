// `jest --json` writes its machine report to stdout while the human report goes to
// stderr. A pipeline that keeps stdout, or uses --outputFile, can therefore retain
// only this document. Each test result also carries the human failure blocks in its
// `message`, so reuse the text parser rather than creating a second interpretation of
// Jest's assertions.
import jest from "./jest.js";
import { SOURCE_RANGE } from "../ownership.js";
import { stripAnsi } from "../util.js";

const REQUIRED_COUNTS = [
  "numFailedTestSuites", "numTotalTestSuites", "numFailedTests", "numTotalTests",
];

const tally = (label, parts, total) =>
  `${label} ${[...parts.filter(([n]) => Number(n) > 0).map(([n, word]) => `${n} ${word}`), `${total} total`].join(", ")}`;

function isJestReport(value) {
  return value && typeof value === "object" && typeof value.success === "boolean" &&
    Array.isArray(value.testResults) &&
    REQUIRED_COUNTS.every((key) => Number.isInteger(value[key]) && value[key] >= 0) &&
    value.testResults.every((result) => result && typeof result.name === "string" &&
      typeof result.status === "string" && typeof result.message === "string");
}

function documents(text) {
  const found = [];
  for (const [line, raw] of text.split("\n").entries()) {
    const candidate = raw.trim();
    if (!candidate.startsWith("{") || !candidate.endsWith("}") ||
        !candidate.includes('"testResults"')) continue;
    let value;
    try { value = JSON.parse(candidate); } catch { continue; }
    if (isJestReport(value)) found.push({ value, line });
  }
  return found;
}

// Vitest writes this same document - it mimics Jest's report deliberately - but leaves
// `message` empty and puts the failure text in each assertion's `failureMessages`
// instead. So the reconstruction below found nothing to reconstruct, jest's reader found
// no blocks in it, and a vitest run that failed two tests came back with no diagnosis.
//
// The two documents say which they are. Jest's carries `wasInterrupted` at the top
// level; vitest's carries `benchmarks` on every assertion. Neither is a guess, and a
// document that says neither is read as before.
const JEST_OWN = (v) => typeof v.wasInterrupted === "boolean";
const VITEST_OWN = (v) => v.testResults.some((r) => Array.isArray(r.assertionResults) &&
  r.assertionResults.some((a) => Array.isArray(a?.benchmarks)));

/** The failure blocks for one file, in the shape the human reporter prints them. */
function blocks(result, separator) {
  if (result.message.trim()) return stripAnsi(result.message);
  const out = [];
  for (const assertion of result.assertionResults ?? []) {
    if (assertion.status !== "failed") continue;
    // `fullName` joins the names with a space, which is neither reporter's separator -
    // so the name is rebuilt from the parts, with the separator the tool displays.
    const name = [...(assertion.ancestorTitles ?? []), assertion.title]
      .filter(Boolean).join(separator);
    out.push(`  ● ${name}`, "");
    for (const line of (assertion.failureMessages ?? []).join("\n").split("\n")) {
      out.push(`    ${stripAnsi(line)}`);
    }
    out.push("");
  }
  return out.join("\n");
}

function humanReport(data, separator) {
  const out = [];
  for (const result of data.testResults) {
    out.push(`${result.status === "failed" ? "FAIL" : "PASS"} ${result.name}`);
    const body = blocks(result, separator);
    if (body.trim()) out.push(body);
  }
  // Jest's terminal order, checked against real paired captures.
  out.push(tally("Test Suites:", [[data.numFailedTestSuites, "failed"],
    [data.numPendingTestSuites, "skipped"], [data.numPassedTestSuites, "passed"]],
  data.numTotalTestSuites));
  out.push(tally("Tests:      ", [[data.numFailedTests, "failed"],
    [data.numPendingTests, "skipped"], [data.numTodoTests, "todo"],
    [data.numPassedTests, "passed"]], data.numTotalTests));
  return out.join("\n");
}

function parsedDocuments(text) {
  const parsed = [];
  for (const document of documents(text)) {
    const mine = VITEST_OWN(document.value) && !JEST_OWN(document.value);
    const result = jest.extract(humanReport(document.value, mine ? " > " : " \u203a "));
    if (!result?.failures?.length) continue;
    for (const failure of result.failures) {
      // A JSON report is one physical source line. Ground every reconstructed failure
      // in that line so mixed-log ownership never confuses it with nearby human output.
      Object.defineProperty(failure, SOURCE_RANGE, {
        value: { start: document.line, end: document.line + 1 }, enumerable: false,
      });
    }
    result.tool = mine ? "vitest" : "jest";
    parsed.push(result);
  }
  return parsed;
}

export default {
  name: "jest --json",
  category: "test",
  commands: ["jest"],

  detect: (text) => documents(text).length > 0,

  extract(text) {
    const results = parsedDocuments(text);
    if (!results.length) return null;
    return {
      // The document says whose it is; a log holding both is read as the one that wrote
      // the most of it rather than as a guess about which came first.
      tool: results.every((r) => r.tool === "vitest") ? "vitest" : "jest",
      // One stream can contain several Jest invocations. Their individual tallies
      // cannot be combined faithfully when a suite failed before any test ran, so do
      // not print a confidently wrong aggregate headline.
      summary: results.length === 1 ? results[0].summary : undefined,
      failures: results.flatMap((result) => result.failures),
    };
  },
};
