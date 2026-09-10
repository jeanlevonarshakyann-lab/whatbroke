const ERR_RE = /^error(?:\[(E\d+)\])?: (.+)$/;
const ARROW_RE = /^[^\S\n]*-->[^\S\n]+(.+?):(\d+):(\d+)[^\S\n]*$/;
const DIFF_CONTEXT_RE = /^[^\S\n]*\d+[^\S\n]+\d+[^\S\n]*\|/;
// cargo indents a build script's captured stderr under "--- stderr", so the panic that
// actually failed the build arrives two spaces in and the anchored pattern missed it.
const PANIC_RE = /^[^\S\n]*thread '(.+?)'(?: \(\d+\))? panicked at (.+?):(\d+):(\d+):$/;
// PANIC_RE is matched line by line, so it carries no `m` flag - which meant using it in
// detect only ever tested the FIRST line of the log. A panic anywhere else went unseen,
// and detection survived on the other alternatives beside it.
const PANIC_ANYWHERE = new RegExp(PANIC_RE.source, "m");
// cargo reports a build-script failure as "failed to run custom build command", which
// is the mechanism; the panic underneath it is the cause, and it is not a test failure.
const BUILD_SCRIPT = /^error: failed to run custom build command/m;
// What says a panic came out of a test run rather than out of the program itself: the
// tally cargo prints at the end, or the per-test stdout block it prints above one.
const RAN_TESTS = /^test result:|^----[^\S\n]+\S.*[^\S\n]+stdout[^\S\n]+----|^running \d+ tests?\b/m;
// A dependency that cannot be resolved never reaches the compiler, so there is no
// E-code and no --> line for detection to key on.
// Cargo's own toplevel complaints - the ones that name no source file because none is
// at fault. Every other bare `error:` line that carries no code, no `-->` and no lint
// belongs to some other tool; git writes `error: Your local changes ...`.
const CARGO_OWN = /^(?:no matching package named|failed to select a version|failed to parse manifest|could not find `[^`]+` in registry|failed to run custom build command|failed to (?:load|download|verify) )/;
const RESOLVE_RE = new RegExp(`^error: ${CARGO_OWN.source.slice(1)}`, "m");
const STDLIB = /\/rustlib\/|\/\.cargo\/registry\//;
// "could not compile ... due to N previous errors" is a tally, not a distinct error
// Cargo's own report of a failure that was already printed above it. "failed to run
// custom build command" belongs here with the rest: it is what cargo says after a build
// script has already panicked and said why, and counting it made one failure into two.
const TALLY_RE = /^could not compile|^aborting due to|^test failed, to rerun|^failed to run custom build command/;

export default {
  name: "cargo",
  category: "compile",
  commands: ["cargo"],
  // A bare "error: ..." line is not enough: bun test writes exactly that. Require
  // something only rustc/cargo emits - an E-code, its "-->" location line, a test
  // result tally, or a rust panic.
  detect: (s) =>
    /^error\[E\d+\]: /m.test(s) ||
    (/^error: /m.test(s) && /^[^\S\n]*-->[^\S\n]+\S+:\d+:\d+[^\S\n]*$/m.test(s)) ||
    /^test result: /m.test(s) ||
    RESOLVE_RE.test(s) ||
    PANIC_ANYWHERE.test(s),

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
        title: pm[1], subject: pm[1],
        category: BUILD_SCRIPT.test(s) ? "build" : (RAN_TESTS.test(s) ? "test" : "runtime"),
        severity: "error", message: msg.join("\n"),
      });
    }
    // A panic used to end the read here. One cargo invocation does not both fail to
    // compile and panic, so there was nothing after it worth scanning - but a CI job
    // that runs `cargo clippy` and then `cargo test` puts both in one log, and returning
    // early threw clippy's fifteen findings away without saying so.
    const panics = failures.length;

    // --- compile errors ---
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(ERR_RE);
      if (!m || TALLY_RE.test(m[2])) continue;

      let loc = null, note = "", stmt = "", lint = "";
      // rustc puts the `-->` on the line straight after the error, every time - the gap
      // is exactly 1 in every captured fixture. Scanning further for one means that in a
      // log holding more than one tool, an `error:` line belonging to somebody else can
      // reach forward and adopt an unrelated tool's location: bun writes `error:` at
      // line start, and ruff writes `--> file:line:col`, so the two combined produced a
      // Rust compile error at a Python file that nothing had reported.
      const LOCATION_WINDOW = 1;
      // The rest of a diagnostic - notes, the echoed source, clippy's lint link - trails
      // further, but not indefinitely.
      const DIAGNOSTIC_WINDOW = 40;
      for (let j = i + 1; j < lines.length && j <= i + DIAGNOSTIC_WINDOW && !ERR_RE.test(lines[j]); j++) {
        // rustc ends a diagnostic block with a blank line. Crossing it lets a bare
        // Cargo error borrow a later Clang/Ruff caret or help line in a mixed job.
        if (!lines[j].trim() && j > i + 1) break;
        const am = lines[j].match(ARROW_RE);
        if (am && !STDLIB.test(am[1])) { if (j - i <= LOCATION_WINDOW) loc ??= { file: am[1], line: +am[2], col: +am[3] }; continue; }
        // rustc's inline annotation on the caret line carries the real explanation
        const cm = lines[j].match(/^[^\S\n]*\|[^\S\n]*[\^~-]+[^\S\n]+(.+)$/);
        if (cm && !note && !STDLIB.test(lines[j])) note = cm[1].trim();
        if (/^help: /.test(lines[j].trim()) && !note) note = lines[j].trim();
        // clippy diagnostics carry no E-code. The lint name is the useful handle -
        // what you would search for, or put in an #[allow(...)]. Take it from the
        // doc-link fragment, which every diagnostic carries; the "-D clippy::name"
        // note appears only once per lint, so repeats would come out untitled.
        const lm = lines[j].match(/rust-clippy\/.*#([a-z_]+)\b/);
        if (lm && !lint) lint = `clippy::${lm[1]}`;
        // rustc echoes the offending line as "N | <source>"
        const sm = lines[j].match(/^[^\S\n]*(\d+)\s\|\s?(.*)$/);
        if (sm && loc && +sm[1] === loc.line && !stmt) stmt = sm[2];
      }
      // An `error:` with no location, no E-code and no lint behind it is not a rustc
      // diagnostic - it is a line that happens to start with the word.
      if (!loc && !m[1] && !lint && !CARGO_OWN.test(m[2])) continue;
      failures.push({
        file: loc?.file, line: loc?.line, col: loc?.col,
        // rustc's E-code, or clippy's lint name, is the identity. Where there is
        // neither - a manifest that will not parse - "error" is the constant cargo
        // prints for the class, which is what `label` is for. Without one of the three
        // a failure says nothing about itself and clustering cannot group it.
        title: m[1] ?? lint ?? "", code: m[1] ?? (lint || undefined),
        label: m[1] || lint ? undefined : "error",
        severity: "error", message: [m[2], note].filter(Boolean).join("\n"), stmt,
      });
    }

    if (!failures.length) return null;
    if (panics) {
      // "FAILED. 1 passed; 2 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s"
      // -> "1 passed; 2 failed"
      const sm = s.match(/^test result: \w+\.[^\S\n]*(.+?)[^\S\n]*$/m);
      const summary = sm?.[1]
        .split(";")
        .map((p) => p.trim())
        .filter((p) => p && !/^0 /.test(p) && !/^finished in/.test(p))
        .join("; ");
      const extra = failures.length - panics;
      const also = extra ? ` — ${extra} compile error${extra > 1 ? "s" : ""} as well` : "";
      // A panic inside a build script is not a test result, however alike they look -
      // and neither is a panic from `cargo run`. A program that panicked on its own says
      // only "thread 'main' panicked at ...", with no tally and no test named above it,
      // and reporting that as a test failure names a command nobody ran.
      if (BUILD_SCRIPT.test(s)) return { tool: "cargo", summary: `build script failed${also}`, failures };
      if (!RAN_TESTS.test(s)) return { tool: "cargo", summary: `panicked${also}`, failures };
      return { tool: "cargo test", summary: (summary ? summary + also : also.trim()) || undefined, failures };
    }
    const n = failures.length;
    return { tool: "cargo", summary: `${n} error${n > 1 ? "s" : ""}`, failures };
  },
};
