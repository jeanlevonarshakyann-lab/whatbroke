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
// golangci-lint prints its findings in exactly go's shape and names the linter in
// brackets at the end. Go writes no such tag - its messages end "in variable
// declaration", never "(errcheck)" - so a line carrying one belongs to golangci-lint and
// reading it here reported a lint run as `go build`, and attached golangci's findings to
// a tool nobody ran. The untagged lines in a golangci typecheck report ARE go's own,
// verbatim, and are still read.
const LINTER_TAG = /[^\S\n]\([a-z][\w-]*\)[^\S\n]*$/;
// `go test -v` - and every `go test -json` stream, which runs verbose underneath - frames
// each test's output with a line naming the test it belongs to. The output comes BEFORE
// the test's "--- FAIL" line, not after it, and parallel tests interleave, switching with
// "=== NAME". Reading forward from "--- FAIL" found nothing for a test that had failed
// and then read on into the next test's frame, so every failure in a verbose log was
// pinned to the NEXT test's output: TestAdd reported with TestTable/zero's error, and
// TestTable/zero with TestParallelA's, a passing test's log included. This is how Go's
// own test2json attributes a line - to the test named in the most recent frame.
const FRAME_RE = /^=== (?:RUN|PAUSE|CONT|NAME)[^\S\n]+(\S+)[^\S\n]*$/;
const RESULT_RE = /^[^\S\n]*--- (PASS|FAIL|SKIP): (\S+)/;
// A package's closing lines end attribution, so a TestAdd in one package is never read
// as the same test as a TestAdd in the next.
const TRAILER_RE = /^(?:(?:FAIL|ok)[^\S\n]+\S+[^\S\n]+(?:[\d.]+s|\(cached\))|FAIL|PASS)[^\S\n]*$/;

/** What one test printed: its location, its messages, and a panic's own frame. */
function details(block) {
  let file, line;
  const msg = [];
  for (let j = 0; j < block.length; j++) {
    const lm = block[j].match(LOC_RE);
    if (lm) { file ??= lm[1]; line ??= +lm[2]; if (lm[3]) msg.push(lm[3]); continue; }
    const pm = block[j].match(/^panic: (.+?)(?:\s\[recovered.*\])?$/);
    if (pm) {
      msg.push(`panic: ${pm[1]}`);
      // first goroutine frame that is not runtime/testing
      for (let k = j + 1; k < block.length; k++) {
        const fm = block[k].match(/^\t(.+?):(\d+)(?:\s|$)/);
        if (fm && !STDLIB.test(fm[1])) { file = fm[1]; line = +fm[2]; break; }
      }
    }
  }
  return { file, line, msg };
}

/** In a verbose log, the lines each failing test printed, keyed by the index of its
 *  "--- FAIL" line. Resolved only once the package is read: a panic's dump comes after
 *  the test's result line, and still belongs to it. A plain log has no frames, and gets
 *  an empty map. */
function verboseBlocks(lines) {
  const out = new Map();
  if (!lines.some((l) => FRAME_RE.test(l))) return out;
  let seg = new Map(), current = null;
  const pending = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const f = l.match(FRAME_RE);
    if (f) { current = f[1]; continue; }
    const r = l.match(RESULT_RE);
    if (r) { if (r[1] === "FAIL") pending.push([i, r[2], seg]); continue; }
    if (TRAILER_RE.test(l)) { current = null; seg = new Map(); continue; }
    if (current == null) continue;
    if (!seg.has(current)) seg.set(current, []);
    seg.get(current).push(l);
  }
  for (const [i, name, s] of pending) out.set(i, s.get(name) ?? []);
  return out;
}

// Go's own runtime/testing frames are never your bug
const STDLIB = /\/(libexec\/)?src\/(runtime|testing|internal)\//;

/** A panic with no test around it: the goroutine dump carries the location, and the
 *  first frame that is not the runtime is the one in your code. */
function standalonePanic(lines) {
  for (let i = 0; i < lines.length; i++) {
    const pm = lines[i].match(/^panic: (.+?)(?:[^\S\n]\[recovered.*\])?$/);
    if (!pm) continue;
    let file, line;
    for (let k = i + 1; k < lines.length; k++) {
      const fm = lines[k].match(/^\t(.+?):(\d+)(?:[^\S\n]|$)/);
      if (fm && !STDLIB.test(fm[1])) { file = fm[1]; line = +fm[2]; break; }
    }
    return { file, line, title: "panic", label: "panic", category: "runtime",
      severity: "error", message: pm[1] };
  }
  return null;
}

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
      if (m && !/^\s/.test(l) && !LINTER_TAG.test(l)) {
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
      // One log can hold both: `go build ./... ; ./prog` puts compile errors and then a
      // panic in the same stream, and golangci-lint prints go's own diagnostics above
      // its tally. Returning here dropped the panic without a word - it is the later and
      // usually the more interesting of the two, so it is kept rather than lost.
      const panic = standalonePanic(lines);
      if (panic) failures.push(panic);
      const andPanic = panic ? " and a panic" : "";
      // Vet's own findings are written exactly like a compile error, so a piped log gives
      // no way to tell them apart. The prefix is the one time it does say.
      return vetted
        ? { tool: "go vet", summary: `${n} error${n > 1 ? "s" : ""}${andPanic}`, failures }
        : { tool: "go build", summary: `${n} compile error${n > 1 ? "s" : ""}${andPanic}`, failures };
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
    const attributed = verboseBlocks(lines);
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(FAIL_RE);
      if (!m || m[1] !== "FAIL") continue;
      const name = m[2];

      // A verbose log says which lines are this test's; use them. Otherwise - and for a
      // test that printed nothing of its own - read on from the result line as a plain
      // log is laid out, but never into the next test's frame.
      const own = attributed.get(i);
      let found = own ? details(own) : { msg: [] };
      if (!found.msg.length && !found.file) {
        const ahead = [];
        for (let j = i + 1; j < lines.length && !FAIL_RE.test(lines[j]) && !FRAME_RE.test(lines[j]); j++) ahead.push(lines[j]);
        found = details(ahead);
      }
      const { file, line, msg } = found;
      if (!msg.length && !file) continue;
      failures.push({ file, line, title: name, subject: name, category: "test", severity: "error", message: msg.join("\n") });
    }

    if (!failures.length) {
      const panic = standalonePanic(lines);
      if (panic) return { tool: "go", summary: "panic", failures: [panic] };
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
