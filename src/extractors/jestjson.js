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

function humanReport(data) {
  const out = [];
  for (const result of data.testResults) {
    out.push(`${result.status === "failed" ? "FAIL" : "PASS"} ${result.name}`);
    if (result.message.trim()) out.push(stripAnsi(result.message));
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
    const result = jest.extract(humanReport(document.value));
    if (!result?.failures?.length) continue;
    for (const failure of result.failures) {
      // A JSON report is one physical source line. Ground every reconstructed failure
      // in that line so mixed-log ownership never confuses it with nearby human output.
      Object.defineProperty(failure, SOURCE_RANGE, {
        value: { start: document.line, end: document.line + 1 }, enumerable: false,
      });
    }
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
      tool: "jest",
      // One stream can contain several Jest invocations. Their individual tallies
      // cannot be combined faithfully when a suite failed before any test ran, so do
      // not print a confidently wrong aggregate headline.
      summary: results.length === 1 ? results[0].summary : undefined,
      failures: results.flatMap((result) => result.failures),
    };
  },
};
