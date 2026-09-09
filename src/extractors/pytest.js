import { isNoise } from "../util.js";

export default {
  name: "pytest",
  category: "test",
  commands: ["pytest", "py.test"],
  detect: (s) =>
    /^=+ test session starts =+$/m.test(s) ||
    /^=+ short test summary info =+$/m.test(s),

  extract(s) {
    const lines = s.split("\n");
    const failures = [];

    // FAILURES / ERRORS sections are split by ____ test name ____ banners.
    const blocks = [];
    let cur = null;
    for (const l of lines) {
      const b = l.match(/^_{3,}[ \t]+(.+?)[ \t]+_{3,}$/);
      if (b) { cur = { title: b[1], body: [] }; blocks.push(cur); continue; }
      if (/^=+ .* =+$/.test(l)) { cur = null; continue; }
      if (cur) cur.body.push(l);
    }

    for (const blk of blocks) {
      // trailing "path:line: ExceptionType"
      let file, line, kind;
      for (let i = blk.body.length - 1; i >= 0; i--) {
        const m = blk.body[i].match(/^(.+?):(\d+):[ \t]*(\w[\w.]*)?[ \t]*$/);
        if (m && !isNoise(m[1])) { file = m[1]; line = +m[2]; kind = m[3]; break; }
      }
      // the failing statement (pytest marks it with ">") and the "E" explanation
      const stmt = blk.body.filter((l) => /^>\s/.test(l)).map((l) => l.slice(1).trim());
      const expl = blk.body.filter((l) => /^E\s/.test(l)).map((l) => l.slice(1).trim());
      if (!expl.length && !stmt.length) continue;
      failures.push({
        file, line,
        title: blk.title, subject: blk.title, severity: "error",
        message: (expl.length ? expl : [kind ?? ""]).join("\n"),
        stmt: stmt[0],
      });
    }

    // "===== 3 failed, 2 passed in 0.01s =====", or with -q the same line
    // with no decoration at all: "85 failed, 1973 passed, 25 skipped in 3.58s"
    let summary;
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i].match(/^=+[ \t]+(.*?(?:failed|passed|error).*?)[ \t]+=+$/i)
             || lines[i].match(/^((?:\d+ (?:failed|passed|skipped|deselected|xfailed|xpassed|error|errors|warning|warnings)(?:, )?)+ in [\d.]+s.*)$/i);
      if (m) { summary = m[1]; break; }
    }
    if (!failures.length && !summary) return null;
    return { tool: "pytest", summary, failures };
  },
};
