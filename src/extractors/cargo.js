const ERR_RE = /^error(?:\[(E\d+)\])?: (.+)$/;
const ARROW_RE = /^\s*-->\s+(.+?):(\d+):(\d+)\s*$/;
const DIFF_CONTEXT_RE = /^\s*\d+\s+\d+\s*\|/;
const PANIC_RE = /^thread '(.+?)'(?: \(\d+\))? panicked at (.+?):(\d+):(\d+):$/;
const STDLIB = /\/rustlib\/|\/\.cargo\/registry\//;
// "could not compile ... due to N previous errors" is a tally, not a distinct error
const TALLY_RE = /^could not compile|^aborting due to|^test failed, to rerun/;

export default {
  name: "cargo",
  // A bare "error: ..." line is not enough: bun test writes exactly that. Require
  // something only rustc/cargo emits - an E-code, its "-->" location line, a test
  // result tally, or a rust panic.
  detect: (s) =>
    /^error\[E\d+\]: /m.test(s) ||
    (/^error: /m.test(s) && /^\s*-->\s+\S+:\d+:\d+\s*$/m.test(s)) ||
    /^test result: /m.test(s) ||
    PANIC_RE.test(s),

  extract(s) {
    const lines = s.split("\n");
    const failures = [];

    // --- test panics: "---- tests::x stdout ----" then "thread '...' panicked at file:l:c:" ---
    for (let i = 0; i < lines.length; i++) {
      const pm = lines[i].match(PANIC_RE);
      if (!pm) continue;
      const msg = [];
      for (let j = i + 1; j < lines.length; j++) {
        const t = lines[j].trim();
        if (!t) { if (msg.length) break; else continue; }
        if (/^note: run with `RUST_BACKTRACE/.test(t) || /^----/.test(t) || /^failures:/.test(t)) break;
        // Snapshot assertions (snapbox, insta) print a diff whose context lines carry
        // BOTH line numbers and a bar - those are the parts that matched. Keeping them
        // fills the budget before the "-"/"+" lines that say what actually changed.
        if (DIFF_CONTEXT_RE.test(t)) continue;
        msg.push(t);
        if (msg.length >= 4) break;
      }
      failures.push({
        file: pm[2], line: +pm[3], col: +pm[4],
        title: pm[1], message: msg.join("\n"),
      });
    }
    if (failures.length) {
      // "FAILED. 1 passed; 2 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s"
      // -> "1 passed; 2 failed"
      const sm = s.match(/^test result: \w+\.\s*(.+?)\s*$/m);
      const summary = sm?.[1]
        .split(";")
        .map((p) => p.trim())
        .filter((p) => p && !/^0 /.test(p) && !/^finished in/.test(p))
        .join("; ");
      return { tool: "cargo test", summary: summary || undefined, failures };
    }

    // --- compile errors ---
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(ERR_RE);
      if (!m || TALLY_RE.test(m[2])) continue;

      let loc = null, note = "", stmt = "", lint = "";
      for (let j = i + 1; j < lines.length && !ERR_RE.test(lines[j]); j++) {
        const am = lines[j].match(ARROW_RE);
        if (am && !STDLIB.test(am[1])) { loc ??= { file: am[1], line: +am[2], col: +am[3] }; continue; }
        // rustc's inline annotation on the caret line carries the real explanation
        const cm = lines[j].match(/^\s*\|\s*[\^~-]+\s+(.+)$/);
        if (cm && !note && !STDLIB.test(lines[j])) note = cm[1].trim();
        if (/^help: /.test(lines[j].trim()) && !note) note = lines[j].trim();
        // clippy diagnostics carry no E-code. The lint name is the useful handle -
        // what you would search for, or put in an #[allow(...)]. Take it from the
        // doc-link fragment, which every diagnostic carries; the "-D clippy::name"
        // note appears only once per lint, so repeats would come out untitled.
        const lm = lines[j].match(/rust-clippy\/.*#([a-z_]+)\b/);
        if (lm && !lint) lint = `clippy::${lm[1]}`;
        // rustc echoes the offending line as "N | <source>"
        const sm = lines[j].match(/^\s*(\d+)\s\|\s?(.*)$/);
        if (sm && loc && +sm[1] === loc.line && !stmt) stmt = sm[2];
      }
      failures.push({
        file: loc?.file, line: loc?.line, col: loc?.col,
        title: m[1] ?? lint ?? "", message: [m[2], note].filter(Boolean).join("\n"), stmt,
      });
    }

    if (!failures.length) return null;
    const n = failures.length;
    return { tool: "cargo", summary: `${n} error${n > 1 ? "s" : ""}`, failures };
  },
};
