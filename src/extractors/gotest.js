const FAIL_RE = /^\s*--- (FAIL|SKIP): (\S+)/;
const LOC_RE = /^\s+([\w./-]+\.go):(\d+):\s*(.*)$/;
const BUILD_RE = /^(?:\.\/)?([\w./-]+\.go):(\d+):(\d+): (.+)$/;
const BUILD_ANY = /^(?:\.\/)?[\w./-]+\.go:\d+:\d+: /m;   // same, but scans a whole blob
// Go's own runtime/testing frames are never your bug
const STDLIB = /\/(libexec\/)?src\/(runtime|testing|internal)\//;

export default {
  name: "go",
  detect: (s) =>
    /^\s*--- FAIL: /m.test(s) || /^(ok|FAIL|---)\s+\S+\s/m.test(s) || BUILD_ANY.test(s),

  extract(s) {
    const lines = s.split("\n");
    const failures = [];

    // --- compile errors: "./file.go:4:17: cannot use 42 ..." ---
    for (const l of lines) {
      const m = l.match(BUILD_RE);
      if (m && !/^\s/.test(l)) {
        failures.push({ file: m[1], line: +m[2], col: +m[3], title: "", message: m[4] });
      }
    }
    if (failures.length) {
      const n = failures.length;
      return { tool: "go build", summary: `${n} compile error${n > 1 ? "s" : ""}`, failures };
    }

    // --- test failures ---
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(FAIL_RE);
      if (!m || m[1] !== "FAIL") continue;
      const name = m[2];

      let file, line, msg = [];
      for (let j = i + 1; j < lines.length && !FAIL_RE.test(lines[j]); j++) {
        const lm = lines[j].match(LOC_RE);
        if (lm) { file ??= lm[1]; line ??= +lm[2]; if (lm[3]) msg.push(lm[3]); continue; }
        const pm = lines[j].match(/^panic: (.+?)(?:\s\[recovered.*\])?$/);
        if (pm) {
          msg.push(`panic: ${pm[1]}`);
          // first goroutine frame that is not runtime/testing
          for (let k = j + 1; k < lines.length; k++) {
            const fm = lines[k].match(/^\t(.+?):(\d+)(?:\s|$)/);
            if (fm && !STDLIB.test(fm[1])) { file = fm[1]; line = +fm[2]; break; }
          }
        }
      }
      if (!msg.length && !file) continue;
      failures.push({ file, line, title: name, message: msg.join("\n") });
    }

    let summary;
    const counts = lines.filter((l) => FAIL_RE.test(l) && /--- FAIL/.test(l)).length;
    if (counts) summary = `${counts} test${counts > 1 ? "s" : ""} failed`;
    if (!failures.length) return null;
    return { tool: "go test", summary, failures };
  },
};
