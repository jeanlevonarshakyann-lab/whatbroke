const LINE_RE = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/;

export default {
  name: "tsc",
  detect: (s) => LINE_RE.test(s.split("\n").find((l) => LINE_RE.test(l)) ?? ""),
  extract(s) {
    const failures = [];
    for (const l of s.split("\n")) {
      const m = l.match(LINE_RE);
      if (!m || m[4] !== "error") continue;
      failures.push({ file: m[1], line: +m[2], col: +m[3], title: m[5], message: m[6] });
    }
    if (!failures.length) return null;
    const files = new Set(failures.map((f) => f.file)).size;
    return {
      tool: "tsc",
      summary: `${failures.length} error${failures.length > 1 ? "s" : ""} in ${files} file${files > 1 ? "s" : ""}`,
      failures,
    };
  },
};
