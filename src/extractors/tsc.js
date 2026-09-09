const CHAIN_RE = /^\s+\S/;   // tsc indents each level of its explanation
const MAX_CHAIN = 3;
const LINE_RE = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/;

export default {
  name: "tsc",
  detect: (s) => LINE_RE.test(s.split("\n").find((l) => LINE_RE.test(l)) ?? ""),
  extract(s) {
    const failures = [];
    const lines = s.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(LINE_RE);
      if (!m || m[4] !== "error") continue;
      // tsc explains an assignability error as an indented chain, and the DEEPEST
      // line is the actual reason - "Type 'string' is not assignable to type
      // 'number'." The head line alone is the least specific thing it said.
      const chain = [];
      for (let j = i + 1; j < lines.length && CHAIN_RE.test(lines[j]); j++) {
        chain.push(lines[j].trim());
        if (chain.length >= MAX_CHAIN) break;
      }
      failures.push({
        file: m[1], line: +m[2], col: +m[3], title: m[5],
        message: [m[6], ...chain].join("\n"),
      });
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
