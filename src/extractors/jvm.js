const SUREFIRE_RE = /^\[ERROR\]\s{2,}([A-Z]\w*)\.(\w+):(\d+)[^\S\n]+(.+)$/;
const MAVEN_RE = /^\[ERROR\][^\S\n]+(.+?):\[(\d+),(\d+)\][^\S\n]+(.+)$/;
const GRADLE_RE = /^(?:e: )?(.+?):(\d+):(\d+):[^\S\n]+(?:(error|warning):[^\S\n]+)?(.+)$/;
const JAVA_RE = /^(.+?\.java):(\d+):[^\S\n]+(error|warning):[^\S\n]+(.+)$/m;

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
    const seen = new Set();
    for (const rawLine of s.split("\n")) {
      const line = rawLine.trim();
      const maven = line.match(MAVEN_RE);
      const gradle = line.match(GRADLE_RE);
      const java = line.match(JAVA_RE);
      const match = maven
        ? { file: maven[1], line: +maven[2], col: +maven[3], message: maven[4] }
        : gradle
          ? { file: gradle[1], line: +gradle[2], col: +gradle[3], severity: gradle[4], message: gradle[5] }
          : java
            ? { file: java[1], line: +java[2], severity: java[3], message: java[4] }
          : null;
      if (!match || /^(?:https?|file):\/\//.test(match.file)) continue;
      if (match.severity === "warning") continue;
      // Gradle repeats compiler diagnostics in its task and failure sections.
      // Deduplicate by diagnostic identity even when the repeated rendering
      // changes indentation or compiler metadata.
      const key = JSON.stringify([match.file, match.line, match.message]);
      if (seen.has(key)) continue;
      seen.add(key);
      const { severity, ...failure } = match;
      failures.push({ ...failure, title: "compile error", label: "compile error", severity: "error" });
    }
    if (!failures.length) {
      // Surefire lists each failed test once, compactly:
      //   [ERROR]   ClassTest.methodName:1055 expected:<...> but was:<...>
      // That single line carries the test, its line, and the assertion. Reporting
      // only "Tests run: 164, Failures: 1" back is a counter, not a diagnosis.
      for (const l of s.split("\n")) {
        const m = l.trim().match(SUREFIRE_RE);
        if (!m) continue;
        failures.push({
          file: `${m[1]}.java`, line: +m[3],
          title: `${m[1]}.${m[2]}`, subject: `${m[1]}.${m[2]}`, category: "test", severity: "error",
          message: m[4].trim(),
        });
      }
      // A build script that fails to evaluate - wrong Gradle version, bad plugin -
      // names its file, its line, and the cause under "* What went wrong:". Without
      // this the whole run produced no output at all.
      if (!failures.length) {
        const where = s.match(/^(?:Build file|Script|Settings file)[^\S\n]+'(.+?)'[^\S\n]+line:[^\S\n]*(\d+)/m);
        const wrong = s.match(/^\* What went wrong:\s*\n([\s\S]*?)(?=\n\* |\n\s*BUILD FAILED|(?![\s\S]))/m);
        if (wrong) {
          const detail = wrong[1].split("\n").map((l) => l.trim())
            .filter(Boolean).map((l) => l.replace(/^>[^\S\n]*/, "")).slice(0, 3);
          failures.push({
            file: where?.[1], line: where ? +where[2] : undefined,
            title: "build script", label: "build script", category: "build", severity: "error", message: detail.join("\n"),
          });
        }
      }
      if (!failures.length) {
        const testFailure = s.match(/^\[ERROR\][^\S\n]+Tests run:.*?(?:Failures|Errors):[^\S\n]*(\d+)/m);
        if (testFailure) failures.push({ title: "test failure", label: "test failure", category: "test", severity: "error", message: testFailure[0].replace(/^\[ERROR\][^\S\n]+/, "") });
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
    const summary = totals && isTestRun ? `Tests run: ${totals[1]}` : "build failed";
    return { tool: isGradle ? "gradle" : isJavac ? "jvm" : "maven", summary, failures };
  },
};
