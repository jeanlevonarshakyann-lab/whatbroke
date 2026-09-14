import { lineAt } from "../util.js";
import { alsoFrom, joinSources, withSource } from "../ownership.js";

const SUREFIRE_RE = /^\[ERROR\]\s{2,}([A-Z]\w*)\.(\w+):(\d+)[^\S\n]+(.+)$/;
const MAVEN_RE = /^\[ERROR\][^\S\n]+(.+?):\[(\d+),(\d+)\][^\S\n]+(.+)$/;
// "file:line:col: message" is the universal compiler diagnostic shape - Go, clang,
// gcc and rustc all print it - so matching it bare made this parser claim their
// output whenever a log held more than one tool. What makes such a line Gradle's is
// either Kotlin's "e: " severity prefix or a JVM source file at the front of it.
const JVM_SRC = /\.(?:java|kt|kts|groovy|scala|gradle)$/;
const GRADLE_RE = /^(e: )?(.+?):(\d+):(\d+):[^\S\n]+(?:(error|warning):[^\S\n]+)?(.+)$/;
// javac translates its severity into the three languages it ships: German, Japanese and
// Simplified Chinese. `A.java:3: Fehler: Inkompatible Typen` is the same diagnostic as
// `A.java:3: error: incompatible types`, and reading only the English word sent a German
// or Japanese build to the generic reader. The set is javac's own and it is closed.
const JAVAC_ERROR = "error|Fehler|\u30a8\u30e9\u30fc|\u9519\u8bef";
const JAVAC_WARNING = "warning|Warnung|\u8b66\u544a";
const JAVA_RE = new RegExp(`^(.+?\\.java):(\\d+):[^\\S\\n]+(${JAVAC_ERROR}|${JAVAC_WARNING}):[^\\S\\n]+(.+)$`, "m");
const javacSeverity = (word) => new RegExp(`^(?:${JAVAC_WARNING})$`).test(word) ? "warning" : "error";
// Gradle's own test logging names each failed test and says where it broke:
//
//   CartTest > totalsAnInvoice() FAILED
//       org.opentest4j.AssertionFailedError at CartTest.java:9
//
// and under exceptionFormat FULL, or --info, gives the message and the stack instead:
//
//   ShippingTest > quotesShipping() FAILED
//       java.lang.IllegalStateException: fixture exploded
//           at shop.ShippingTest.quotesShipping(ShippingTest.java:8)
//
// Nothing read either. What came back was the consequence - "Execution failed for task
// ':test'" under "* What went wrong:" - labelled a build script error, with no test, no
// file and no line, from a log that named both failing tests and where each one broke.
//
// A nested class is written `Outer > Inner > method() FAILED`. The class comes first and
// starts like a Java name, which `> Task :test FAILED` does not.
const GRADLE_TEST_RE = /^([A-Za-z_$][\w.$]*(?:[^\S\n]+>[^\S\n]+.+?)+)[^\S\n]+FAILED[^\S\n]*$/;
const GRADLE_SHORT_RE = /^[^\S\n]+([\w.$]+)[^\S\n]+at[^\S\n]+([^\s:]+\.(?:java|kt|groovy|scala)):(\d+)[^\S\n]*$/;
const GRADLE_FRAME_RE = /^[^\S\n]+at[^\S\n]+(?:[\w.-]+\/\/)?([\w.$]+)\.([\w$<>-]+)\(([^:()\s]+\.(?:java|kt|groovy|scala)):(\d+)\)[^\S\n]*$/;

/** The failed tests in Gradle's own test logging. */
function gradleTests(s) {
  const lines = s.split("\n");
  const out = [];
  // Gradle's own tally, which says a test run happened at all.
  const tallied = /^[^\S\n]*\d+ tests? completed, \d+ failed/m.test(s);
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i].match(GRADLE_TEST_RE);
    if (!head) continue;
    const parts = head[1].split(/[^\S\n]+>[^\S\n]+/);
    const cls = parts[0];
    const method = parts.at(-1).replace(/\(.*\)$/, "");
    // The block is everything indented under the header, and ends at the first line
    // that is not - which is where Gradle's next test, or its tally, begins.
    const block = [];
    let j = i + 1;
    for (; j < lines.length && /^[^\S\n]+\S/.test(lines[j]); j++) block.push(lines[j]);
    // A header whose detail is not under it - another stream's line landed between
    // them, or the capture was cut - is still Gradle saying this test failed. With
    // Gradle's tally in the same log to say a test run happened, it is reported; the
    // log simply does not say where or why.
    if (!block.length) {
      if (!tallied) continue;
      const name = head[1].trim();
      out.push(withSource({
        title: name, subject: name, category: "test", severity: "error",
        message: "Gradle reported this test as failed; its detail is not in this log",
      }, i, i + 1));
      continue;
    }
    let file, line, message;
    const short = block[0].match(GRADLE_SHORT_RE);
    if (short) {
      // The short format says which exception and where, and nothing about why.
      [, message, file, line] = short;
    } else {
      message = block.find((l) => !GRADLE_FRAME_RE.test(l))?.trim();
      const frames = block.map((l) => l.match(GRADLE_FRAME_RE)).filter(Boolean);
      // The frame in the test's own class, not the assertion library's above it.
      const own = frames.filter((f) => f[1].split(/[.$]/).includes(cls));
      const at = own.find((f) => f[2] === method) ?? own[0];
      if (at) { file = at[3]; line = at[4]; }
    }
    if (!message) continue;
    const name = head[1].trim();
    // The header and the block indented under it.
    out.push(withSource({
      file, line: line === undefined ? undefined : +line,
      title: name, subject: name, category: "test", severity: "error", message,
    }, i, j));
  }
  return out;
}

export default {
  name: "jvm",
  category: "compile",
  commands: ["javac", "mvn", "maven", "gradle", "gradlew"],
  detect: (s) =>
    /^\[ERROR\][^\S\n]+(?:Failed to execute goal|COMPILATION ERROR|Tests run:)/m.test(s) ||
    /^> Task .+ FAILED$/m.test(s) ||
    /^FAILURE: Build failed with an exception\./m.test(s) ||
    JAVA_RE.test(s),

  extract(s) {
    const failures = [];
    const seen = new Map();
    const lines = s.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      const maven = line.match(MAVEN_RE);
      const g = line.match(GRADLE_RE);
      const gradle = g && (g[1] || JVM_SRC.test(g[2])) ? g : null;
      const java = line.match(JAVA_RE);
      const match = maven
        ? { file: maven[1], line: +maven[2], col: +maven[3], message: maven[4] }
        : gradle
          ? { file: gradle[2], line: +gradle[3], col: +gradle[4], severity: gradle[5], message: gradle[6] }
          : java
            ? { file: java[1], line: +java[2], severity: javacSeverity(java[3]), message: java[4] }
          : null;
      if (!match || /^(?:https?|file):\/\//.test(match.file)) continue;
      if (match.severity === "warning") continue;
      // Gradle repeats compiler diagnostics in its task and failure sections.
      // Deduplicate by diagnostic identity even when the repeated rendering
      // changes indentation or compiler metadata.
      const key = JSON.stringify([match.file, match.line, match.message]);
      const { severity, ...failure } = match;
      const placed = withSource({ ...failure, title: "compile error", label: "compile error", severity: "error" }, i, i + 1);
      // ...where it was said again, it was read again.
      if (seen.has(key)) { failures[seen.get(key)] = joinSources(failures[seen.get(key)], placed); continue; }
      seen.set(key, failures.length);
      failures.push(placed);
    }
    // Gradle's test failures are read whatever else is in the log. The branches below
    // are fallbacks - what to say when nothing more specific was found - but a test that
    // failed is not a fallback for a compile error, and a log holding one Gradle run that
    // would not compile and another whose tests failed lost the second run whole.
    for (const t of gradleTests(s)) {
      const key = JSON.stringify([t.subject, t.file, t.line]);
      if (seen.has(key)) { failures[seen.get(key)] = joinSources(failures[seen.get(key)], t); continue; }
      seen.set(key, failures.length);
      failures.push(t);
    }
    if (!failures.length) {
      // Surefire lists each failed test once, compactly:
      //   [ERROR]   ClassTest.methodName:1055 expected:<...> but was:<...>
      // That single line carries the test, its line, and the assertion. Reporting
      // only "Tests run: 164, Failures: 1" back is a counter, not a diagnosis.
      lines.forEach((l, i) => {
        const m = l.trim().match(SUREFIRE_RE);
        if (!m) return;
        failures.push(withSource({
          file: `${m[1]}.java`, line: +m[3],
          title: `${m[1]}.${m[2]}`, subject: `${m[1]}.${m[2]}`, category: "test", severity: "error",
          message: m[4].trim(),
        }, i, i + 1));
      });
      // A build script that fails to evaluate - wrong Gradle version, bad plugin -
      // names its file, its line, and the cause under "* What went wrong:". Without
      // this the whole run produced no output at all.
      if (!failures.length) {
        const where = s.match(/^(?:Build file|Script|Settings file)[^\S\n]+'(.+?)'[^\S\n]+line:[^\S\n]*(\d+)/m);
        const wrong = s.match(/^\* What went wrong:\s*\n([\s\S]*?)(?=\n\* |\n\s*BUILD FAILED|(?![\s\S]))/m);
        if (wrong) {
          const detail = wrong[1].split("\n").map((l) => l.trim())
            .filter(Boolean).map((l) => l.replace(/^>[^\S\n]*/, "")).slice(0, 3);
          // Under -q Gradle prints no test names at all - only its tally and "There were
          // failing tests" under the consequence. That is a test failure whose tests are
          // not in the log, not a build script that would not evaluate.
          const tests = /There were failing tests/.test(wrong[1]);
          const tally = s.match(/^[^\S\n]*(\d+ tests? completed, \d+ failed.*?)[^\S\n]*$/m);
          // The "What went wrong" section, and the line naming the script when there is one.
          const said = { start: lineAt(s, wrong.index), end: lineAt(s, wrong.index + wrong[0].length - 1) + 1 };
          let failure = withSource({
            file: where?.[1], line: where ? +where[2] : undefined,
            title: tests ? "tests failed" : "build script", label: tests ? "tests failed" : "build script",
            category: tests ? "test" : "build", severity: "error",
            message: (tests && tally ? [tally[1], ...detail] : detail).join("\n"),
          }, said.start, said.end);
          if (where) failure = alsoFrom(failure, lineAt(s, where.index), lineAt(s, where.index) + 1);
          if (tests && tally) failure = alsoFrom(failure, lineAt(s, tally.index), lineAt(s, tally.index) + 1);
          failures.push(failure);
        }
      }
      // Maven reports everything that is not a compiler diagnostic the same way: the
      // goal that failed, then the reason on the lines below it. Dependency resolution,
      // a plugin that blew up, a missing profile - none of them has a file or a line,
      // and without this branch a build that could not resolve a dependency produced no
      // diagnosis at all.
      if (!failures.length) {
        const all = s.split("\n");
        const at = all.findIndex((l) => /^\[ERROR\][^\S\n]+Failed to execute goal/.test(l));
        if (at >= 0) {
          const head = all[at].replace(/^\[ERROR\][^\S\n]+/, "");
          const detail = [];
          let end = at + 1;
          for (let j = at + 1; j < all.length && detail.length < 3; j++) {
            if (!/^\[ERROR\]/.test(all[j])) break;
            const t = all[j].replace(/^\[ERROR\][^\S\n]*/, "").trim();
            // everything from "-> [Help 1]" down is Maven telling you how to get more
            // output, not telling you what went wrong
            if (!t || /^->[^\S\n]*\[Help/.test(t) || /^(?:To see the full stack trace|Re-run Maven)/.test(t)) break;
            detail.push(t);
            end = j + 1;
          }
          failures.push(withSource({
            title: "goal failed", label: "goal failed", category: "build", severity: "error",
            message: [head, ...detail].join("\n"),
          }, at, end));
        }
      }
      if (!failures.length) {
        const testFailure = s.match(/^\[ERROR\][^\S\n]+Tests run:.*?(?:Failures|Errors):[^\S\n]*(\d+)/m);
        if (testFailure) {
          const at = lineAt(s, testFailure.index);
          failures.push(withSource({ title: "test failure", label: "test failure", category: "test", severity: "error", message: testFailure[0].replace(/^\[ERROR\][^\S\n]+/, "") }, at, at + 1));
        }
      }
    }
    if (!failures.length) return null;
    const isGradle = /^> Task .+ FAILED$/m.test(s) || /^FAILURE: Build failed/m.test(s);
    const isMaven = /^\[ERROR\]/m.test(s);
    const isJavac = !isMaven && JAVA_RE.test(s);
    // Surefire prints a "Tests run:" line per class and one for the whole run.
    // The last one is the run total; the first is whichever class failed first.
    const totals = [...s.matchAll(/^\[ERROR\][^\S\n]+Tests run:[^\S\n]*(.+?)(?:,[^\S\n]*Time elapsed.*)?$/gm)].at(-1);
    const isTestRun = failures.some((f) => f.title?.includes(".") && /\.java$/.test(f.file ?? ""));
    const gradleTally = s.match(/^[^\S\n]*(\d+ tests? completed, \d+ failed.*?)[^\S\n]*$/m);
    const summary = totals && isTestRun ? `Tests run: ${totals[1]}`
      : gradleTally && failures.some((f) => f.category === "test") ? gradleTally[1]
      : "build failed";
    return { tool: isGradle ? "gradle" : isJavac ? "jvm" : "maven", summary, failures };
  },
};
