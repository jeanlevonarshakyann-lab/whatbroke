import { elements, firstElement, xmlAttributes, xmlText } from "../util.js";
// The reports a JVM build leaves behind - Maven Surefire's target/surefire-reports and
// Gradle's build/test-results - are what a CI job keeps and what every test dashboard
// reads. Neither was read: the generic fallback found one location in the log, and it was
// a line inside JUnit's own assertion builder rather than the test that failed.
//
// Surefire writes two of them, an XML document and a plain-text summary per class:
//
//   <testcase name="totalsAnInvoice" classname="shop.CartTest" time="0.002">
//     <failure message="expected: &lt;6&gt; but was: &lt;4&gt;" type="...">
//       <![CDATA[org.opentest4j.AssertionFailedError: expected: <6> but was: <4>
//     	at org.junit.jupiter.api.AssertionFailureBuilder.build(AssertionFailureBuilder.java:151)
//     	...
//     	at shop.CartTest.totalsAnInvoice(CartTest.java:9)
//
//   shop.CartTest.totalsAnInvoice -- Time elapsed: 0.002 s <<< FAILURE!
//   org.opentest4j.AssertionFailedError: expected: <6> but was: <4>
//   	at ...
//
// Gradle writes the same XML without the CDATA and with `()` after the method's name.
//
// JUnit's XML is a shape every runner writes, and node's, PHPUnit's and vitest's are all
// read elsewhere. What makes a case a JVM test is inside it: a Java stack frame naming
// the case's own class. That is also where the location comes from - the frame in the
// test, not the ones in the assertion library above it.
// A failed test's tally line: `Time elapsed:` and, further along the same line, `<<<
// FAILURE!` - `/Time elapsed:.*<<<[^\S\n]+(?:FAILURE|ERROR)!/`. Tried from every `Time
// elapsed:`, a long line of tallies read to its end once per tally. The first one on a
// line sees everything a later one does.
export const FAILED_TALLY = /^(?:(?!Time elapsed:)[^\n\r\u2028\u2029])*Time elapsed:.*<<<[^\S\n]+(?:FAILURE|ERROR)!/m;
const CASE_RE = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
const OUTCOME_RE = /<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/;
const CASE = { open: /<testcase\b/, close: () => "</testcase>", selfClosing: true };
const OUTCOME = { open: /<(failure|error)\b/, close: (name) => `</${name}>`, selfClosing: true };
const CDATA_RE = /<!\[CDATA\[([\s\S]*?)\]\]>/g;
// `at shop.CartTest.totalsAnInvoice(CartTest.java:9)`, with the classloader prefix
// Gradle's console adds - `app//` - allowed for.
const FRAME_RE = /^[^\S\n]*at[^\S\n]+(?:[\w.-]+\/\/)?([\w.$]+)\.([\w$<>-]+)\(([^:()\s]+\.(?:java|kt|groovy|scala)):(\d+)\)[^\S\n]*$/;
// The Surefire schema, which only Surefire references.
const SUREFIRE_SCHEMA = /surefire-test-report\.xsd|maven-surefire-plugin/;
// `shop.CartTest.totalsAnInvoice -- Time elapsed: 0.002 s <<< FAILURE!`, and the older
// `totalsAnInvoice(shop.CartTest)  Time elapsed: 0.002 sec  <<< FAILURE!`.
const TXT_HEAD_RE = /^(?:([\w.$]+)\.([\w$]+)[^\S\n]+--[^\S\n]+|([\w$]+)\(([\w.$]+)\)[^\S\n]+)Time elapsed:.*?<<<[^\S\n]+(?:FAILURE|ERROR)![^\S\n]*$/;

const simple = (cls) => cls.split(".").pop();

/** Where in the test's own class the failure happened, from a Java stack.
 *
 *  The frame naming the test method is the best answer; a failure in a setup method or a
 *  helper still passes through the test class, so any frame in that class will do next.
 *  No frame in the class at all means this stack is not this test's. */
function located(lines, cls, method) {
  const frames = lines.map((l) => l.match(FRAME_RE)).filter(Boolean);
  const inClass = frames.filter((f) => f[1] === cls || f[1].startsWith(`${cls}$`));
  const at = inClass.find((f) => f[2] === method) ?? inClass[0];
  return at ? { file: at[3], line: +at[4] } : null;
}

/** The exception's own line: the first line of the stack that is not a frame. */
function said(lines) {
  return lines.map((l) => l.trim()).find((l) => l && !FRAME_RE.test(l) && !/^\.\.\. \d+ more$/.test(l)) ?? "";
}

/** The failed cases of any JVM JUnit XML documents in `s`. */
function xmlCases(s) {
  if (!s.includes("<testcase")) return [];
  const out = [];
  for (const test of elements(s, CASE_RE, CASE)) {
    if (!test[2]) continue;
    const outcome = firstElement(test[2], OUTCOME_RE, OUTCOME);
    if (!outcome) continue;
    const a = xmlAttributes(test[1]);
    if (!a.classname || !a.name) continue;
    const raw = outcome[3] ?? "";
    // CDATA is literal text; everything outside it is escaped.
    const body = raw.includes("<![CDATA[")
      ? [...raw.matchAll(CDATA_RE)].map((m) => m[1]).join("\n")
      : xmlText(raw);
    const lines = body.split("\n");
    // Gradle names the method `totalsAnInvoice()`, and a parameterised one carries its
    // arguments in the brackets; the frame names the method alone.
    const method = a.name.replace(/\(.*\)$/, "");
    const at = located(lines, a.classname, method);
    if (!at) continue;
    const name = `${simple(a.classname)}.${method}`;
    // Which document a case belongs to decides who wrote it, and that is read from the
    // document's own root - not from the log, which can hold Maven's console beside
    // Gradle's report and would then rename Gradle's report after Maven.
    const roots = [...s.slice(0, test.index).matchAll(/<testsuite\b[^>]*>/g)];
    const root = roots.at(-1)?.[0] ?? "";
    out.push({
      ...at, title: name, subject: name, category: "test", severity: "error",
      message: said(lines) || xmlAttributes(outcome[2]).message || outcome[1],
      origin: SUREFIRE_SCHEMA.test(root) ? "maven" : "junit",
    });
  }
  return out;
}

/** The failed tests of a Surefire plain-text report. */
function txtCases(s) {
  if (!FAILED_TALLY.test(s)) return [];
  const lines = s.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i].match(TXT_HEAD_RE);
    if (!head) continue;
    const cls = head[1] ?? head[4];
    const method = head[2] ?? head[3];
    // The exception and its frames follow the header, and end at the blank line
    // Surefire leaves before the next test or the next class.
    const block = [];
    for (let j = i + 1; j < lines.length && lines[j].trim() && !TXT_HEAD_RE.test(lines[j]); j++) {
      block.push(lines[j]);
    }
    const at = located(block, cls, method);
    if (!at) continue;
    const name = `${simple(cls)}.${method}`;
    out.push({ ...at, title: name, subject: name, category: "test", severity: "error", message: said(block), origin: "maven" });
  }
  return out;
}

export default {
  name: "junit jvm",
  category: "test",
  commands: ["mvn", "maven", "gradle", "gradlew"],

  detect: (s) => xmlCases(s).length > 0 || txtCases(s).length > 0,

  extract(s) {
    const failures = [];
    const seen = new Set();
    let surefire = false;
    for (const { origin, ...f } of [...xmlCases(s), ...txtCases(s)]) {
      // `cat target/surefire-reports/*` holds each failure twice, once per format.
      const key = [f.subject, f.file, f.line].join("\u0000");
      if (seen.has(key)) continue;
      seen.add(key);
      if (origin === "maven") surefire = true;
      failures.push(f);
    }
    if (!failures.length) return null;
    const n = failures.length;
    return {
      // Surefire's documents say whose they are; Gradle's XML says nothing about which
      // build tool wrote it, so it is named for what it is.
      tool: surefire ? "maven" : "junit",
      summary: `${n} test${n === 1 ? "" : "s"} failed`,
      failures,
    };
  },
};
