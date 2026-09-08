const MAVEN_RE = /^\[ERROR\]\s+(.+?):\[(\d+),(\d+)\]\s+(.+)$/;
const GRADLE_RE = /^(?:e: )?(.+?):(\d+):(\d+):\s+(.+)$/;

export default {
  name: "jvm",
  detect: (s) =>
    /^\[ERROR\]\s+(?:Failed to execute goal|COMPILATION ERROR|Tests run:)/m.test(s) ||
    /^> Task .+ FAILED$/m.test(s) ||
    /^FAILURE: Build failed with an exception\./m.test(s),

  extract(s) {
    const failures = [];
    const seen = new Set();
    for (const line of s.split("\n")) {
      const maven = line.match(MAVEN_RE);
      const gradle = line.match(GRADLE_RE);
      const match = maven
        ? { file: maven[1], line: +maven[2], col: +maven[3], message: maven[4] }
        : gradle
          ? { file: gradle[1], line: +gradle[2], col: +gradle[3], message: gradle[4] }
          : null;
      if (!match || /^(?:https?|file):\/\//.test(match.file)) continue;
      const key = JSON.stringify(match);
      if (seen.has(key)) continue;
      seen.add(key);
      failures.push({ ...match, title: "compile error" });
    }
    if (!failures.length) {
      const testFailure = s.match(/^\[ERROR\]\s+Tests run:.*?(?:Failures|Errors):\s*(\d+)/m);
      if (testFailure) failures.push({ title: "test failure", message: testFailure[0].replace(/^\[ERROR\]\s+/, "") });
    }
    if (!failures.length) return null;
    const isGradle = /^> Task .+ FAILED$/m.test(s) || /^FAILURE: Build failed/m.test(s);
    const summary = isGradle ? "build failed" : "build failed";
    return { tool: isGradle ? "gradle" : "maven", summary, failures };
  },
};
