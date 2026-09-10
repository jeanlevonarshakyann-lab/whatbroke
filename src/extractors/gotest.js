const FAIL_RE = /^[^\S\n]*--- (FAIL|SKIP): (\S+)/;
const PANIC_RE = /^panic: (.+?)(?:[^\S\n]\[recovered.*\])?$/m;
const LOC_RE = /^[^\S\n]+([\w./\\-]+\.go):(\d+):[^\S\n]*(.*)$/;
// `go vet` prefixes the line when the package will not compile at all - "vet: ./main.go:
// 6:17: cannot use ..." - and that prefix defeated the anchor, so a vet run that hit a
// type error came back as a guess with no location, with the file and line sitting in
// plain sight inside the message. Vet's own findings carry no prefix and already matched.
//
// On Windows the prefix is `vet.exe: ` and the path is `pkg\helper.go` or `.\main.go`,
// separators and all. A class written [\w./-] matches none of that, so `go build` on a
// Windows runner fell through to the fallback and `go vet` lost both its locations -
// while `go test` was unaffected, because the testing package prints a bare basename and
// the runtime writes its frames with forward slashes even there. Captured on
// windows-latest rather than assumed; go_windows_build_fail is that output.
const BUILD_RE = /^(vet(?:\.exe)?: )?(?:\.[\\/])?([\w./\\-]+\.go):(\d+):(\d+): (.+)$/;
const BUILD_ANY = /^(?:vet(?:\.exe)?: )?(?:\.[\\/])?[\w./\\-]+\.go:\d+:\d+: /m;   // same, but scans a whole blob
// Go's own runtime/testing frames are never your bug
const STDLIB = /\/(libexec\/)?src\/(runtime|testing|internal)\//;

export default {
  name: "go",
  category: "compile",
  commands: ["go"],
  detect: (s) =>
    /^[^\S\n]*--- FAIL: /m.test(s) || /^(ok|FAIL|---)[^\S\n]+\S+\s/m.test(s) || BUILD_ANY.test(s) ||
    // A binary that panics outside a test run has none of the above: no test tally, no
    // --- FAIL line, nothing but the panic and its goroutine dump. `go run` produces
    // exactly that, and it is the commonest way a Go program fails.
    (PANIC_RE.test(s) && /^goroutine \d+ \[/m.test(s)),

  extract(s) {
    const lines = s.split("\n");
    const failures = [];

    // --- compile errors: "./file.go:4:17: cannot use 42 ..." ---
    let vetted = false;
    for (const l of lines) {
      const m = l.match(BUILD_RE);
      if (m && !/^\s/.test(l)) {
        if (m[1]) vetted = true;
        // Go writes no severity word at all, so there is no constant of its own to put
        // in `label` - but the line still needs a name, or it renders as a bare
        // "broken.go:4" that the problem matcher cannot read and CI never annotates.
        // "compile error" is what whatbroke calls it, which is what `title` is for.
        failures.push({ file: m[2], line: +m[3], col: +m[4], title: "compile error", severity: "error", message: m[5] });
      }
    }
    if (failures.length) {
      const n = failures.length;
      // Vet's own findings are written exactly like a compile error, so a piped log gives
      // no way to tell them apart. The prefix is the one time it does say.
      return vetted
        ? { tool: "go vet", summary: `${n} error${n > 1 ? "s" : ""}`, failures }
        : { tool: "go build", summary: `${n} compile error${n > 1 ? "s" : ""}`, failures };
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

    // A panic with no test around it: the goroutine dump carries the location, and the
    // first frame that is not the runtime is the one in your code.
    if (!failures.length) {
      for (let i = 0; i < lines.length; i++) {
        const pm = lines[i].match(/^panic: (.+?)(?:[^\S\n]\[recovered.*\])?$/);
        if (!pm) continue;
        let file, line;
        for (let k = i + 1; k < lines.length; k++) {
          const fm = lines[k].match(/^\t(.+?):(\d+)(?:[^\S\n]|$)/);
          if (fm && !STDLIB.test(fm[1])) { file = fm[1]; line = +fm[2]; break; }
        }
        failures.push({ file, line, title: "panic", label: "panic", category: "runtime",
          severity: "error", message: pm[1] });
        break;
      }
      if (failures.length) return { tool: "go", summary: "panic", failures };
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
