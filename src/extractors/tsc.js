const CHAIN_RE = /^[^\S\n]+\S/;   // tsc indents each level of its explanation
const MAX_CHAIN = 3;
const LINE_RE = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/;
// Not every tsc error is about a position in a file. A bad tsconfig, a missing input,
// an unknown flag - those are reported with no location at all, and requiring one meant
// they were dropped without a word. A run reporting three errors came back with two.
const BARE_RE = /^(error|warning) (TS\d+): (.*)$/;

export default {
  name: "tsc",
  category: "typecheck",
  commands: ["tsc", "vue-tsc"],
  detect: (s) => s.split("\n").some((l) => LINE_RE.test(l) || BARE_RE.test(l)),
  extract(s) {
    const failures = [];
    const lines = s.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const bare = lines[i].match(BARE_RE);
      if (bare) {
        if (bare[1] === "error") {
          failures.push({ title: bare[2], code: bare[2], severity: "error", message: bare[3] });
        }
        continue;
      }
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
        file: m[1], line: +m[2], col: +m[3], title: m[5], code: m[5], severity: "error",
        message: [m[6], ...chain].join("\n"),
      });
    }
    if (!failures.length) return null;
    // A config-level error belongs to no file, so counting files would say "in 0 files".
    const files = new Set(failures.map((f) => f.file).filter(Boolean)).size;
    const n = `${failures.length} error${failures.length > 1 ? "s" : ""}`;
    return {
      tool: "tsc",
      summary: files ? `${n} in ${files} file${files > 1 ? "s" : ""}` : n,
      failures,
    };
  },
};
