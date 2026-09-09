const FAIL_RE = /^[^\S\n]*--- (FAIL|SKIP): (\S+)/;
const LOC_RE = /^[^\S\n]+([\w./-]+\.go):(\d+):[^\S\n]*(.*)$/;
const BUILD_RE = /^(?:\.\/)?([\w./-]+\.go):(\d+):(\d+): (.+)$/;
const BUILD_ANY = /^(?:\.\/)?[\w./-]+\.go:\d+:\d+: /m;   // same, but scans a whole blob
// Go's own runtime/testing frames are never your bug
const STDLIB = /\/(libexec\/)?src\/(runtime|testing|internal)\//;

export default {
  name: "go",
  category: "compile",
  commands: ["go"],
  detect: (s) =>
    /^[^\S\n]*--- FAIL: /m.test(s) || /^(ok|FAIL|---)[^\S\n]+\S+\s/m.test(s) || BUILD_ANY.test(s),

  extract(s) {
    const lines = s.split("\n");
    const failures = [];

    // --- compile errors: "./file.go:4:17: cannot use 42 ..." ---
    for (const l of lines) {
      const m = l.match(BUILD_RE);
      if (m && !/^\s/.test(l)) {
        failures.push({ file: m[1], line: +m[2], col: +m[3], title: "", severity: "error", message: m[4] });
      }
    }
    if (failures.length) {
      const n = failures.length;
      return { tool: "go build", summary: `${n} compile error${n > 1 ? "s" : ""}`, failures };
    }

    // --- data races ---
    // The detector names the exact line where the racing access happened, which is
    // the bug. The test assertion that follows only reports a wrong total, so
    // without this the output points at the symptom and drops the cause.
    for (let i = 0; i < lines.length; i++) {
      if (!/^WARNING: DATA RACE[^\S\n]*$/.test(lines[i])) continue;
      let file, line;
      const what = [];
      for (let j = i + 1; j < lines.length && !/^={10,}$/.test(lines[j]); j++) {
        const op = lines[j].match(/^((?:Previous )?(?:read|write)) at 0x[0-9a-f]+ by (goroutine \d+|main goroutine)/i);
        if (op) { what.push(`${op[1]} by ${op[2]}`); continue; }
        const at = lines[j].match(/^[^\S\n]+(\S+):(\d+) \+0x[0-9a-f]+[^\S\n]*$/);
        if (at && !file && !STDLIB.test(at[1])) { file = at[1]; line = +at[2]; }
      }
      if (!what.length) continue;
      failures.push({
        file, line, title: "DATA RACE", label: "DATA RACE", category: "test", severity: "error",
        message: what.slice(0, 2).join(", ") + " - the same memory, without synchronisation",
      });
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
      failures.push({ file, line, title: name, subject: name, category: "test", severity: "error", message: msg.join("\n") });
    }

    // count what we actually report: a parent of subtests prints its own
    // "--- FAIL" line but carries no failure of its own
    const races = failures.filter((f) => f.title === "DATA RACE").length;
    const tests = failures.length - races;
    const bits = [];
    if (tests) bits.push(`${tests} test${tests > 1 ? "s" : ""} failed`);
    if (races) bits.push(`${races} data race${races > 1 ? "s" : ""}`);
    const summary = bits.length ? bits.join(", ") : undefined;
    if (!failures.length) return null;
    return { tool: "go test", summary, failures };
  },
};
