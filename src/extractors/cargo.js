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
const RAN_TESTS = /^test result:|^----[^\S\n]+\S.*[^\S\n]+stdout[^\S\n]+----/m;
// A dependency that cannot be resolved never reaches the compiler, so there is no
// E-code and no --> line for detection to key on.
// Cargo's own toplevel complaints - the ones that name no source file because none is
// at fault. Every other bare `error:` line that carries no code, no `-->` and no lint
// belongs to some other tool; git writes `error: Your local changes ...`.
const CARGO_OWN = /^(?:no matching package named|failed to select a version|failed to parse manifest|could not find `[^`]+` in registry|failed to run custom build command|failed to (?:load|download|verify) )/;
const RESOLVE_RE = new RegExp(`^error: ${CARGO_OWN.source.slice(1)}`, "m");
const STDLIB = /\/rustlib\/|\/\.cargo\/registry\//;
// `--message-format=short` puts the whole diagnostic on one line and drops the `-->`
// entirely, so nothing here matched it and a real compile failure came out of the
// fallback - with the "could not compile" tally counted as a third error, and no error
// codes to group on. The file has to be a Rust source: without that the shape is just
// `file:line:col: error:`, which is half the tools in the corpus.
const SHORT_RE = /^(.+?\.rs):(\d+):(\d+):[^\S\n]+(error|warning)(?:\[(E\d+)\])?:[^\S\n]*(.*?)[^\S\n]*$/;
// A warning does not fail the build, and it is not reported as a failure - but the JSON
// form has always said how many there were, "2 errors - 1 warning hidden", and the text
// form of the same run said "2 errors". rustc writes a warning as it writes an error:
//
//   warning: unnecessary parentheses around assigned value
//    --> src/lib.rs:2:16
//   warning[E0602]: unknown lint: `no_such_lint`
//     |
//
// cargo writes its own warnings the same way - `warning: build failed, waiting for other
// jobs to finish...`, `warning: `shop` (lib) generated 1 warning` - with nothing under
// them. So a warning counts when rustc's location or gutter follows it, or when it
// carries an error code, which cargo's own never do. --message-format=short keeps the
// location on the line and drops the gutter; a warning with neither a location nor a code
// is, in that format, the one thing indistinguishable from cargo's own chatter.
const WARNING_RE = /^warning(?:\[(E\d+)\])?:[^\S\n]+(.+?)[^\S\n]*$/;
const GUTTER_RE = /^[^\S\n]*\|[^\S\n]*$/;

/** The distinct compiler warnings a text log shows. */
function warningsShown(lines) {
  const seen = new Set();
  for (let i = 0; i < lines.length; i++) {
    const short = lines[i].match(SHORT_RE);
    if (short) {
      if (short[4] === "warning") seen.add([short[6], short[1], short[2], short[3]].join("|"));
      continue;
    }
    const m = lines[i].match(WARNING_RE);
    if (!m) continue;
    const at = lines[i + 1]?.match(ARROW_RE);
    if (!at && !m[1] && !GUTTER_RE.test(lines[i + 1] ?? "")) continue;
    seen.add(at ? [m[2], at[1], at[2], at[3]].join("|") : m[2]);
  }
  return seen.size;
}
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
    s.split("\n").some((l) => SHORT_RE.test(l)) ||
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

    // --- --message-format=short: one line, location first, no `-->` beneath it ---
    for (const line of lines) {
      const m = line.match(SHORT_RE);
      if (!m || m[4] !== "error") continue;
      failures.push({
        file: m[1], line: +m[2], col: +m[3],
        title: m[5] ?? "error", ...(m[5] ? { code: m[5] } : { label: "error" }),
        severity: "error", message: m[6],
      });
    }

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
        // rustc's inline annotation on the caret line carries the real explanation. It is
        // the text after the LAST run of markers: rustc draws a secondary span with dashes
        // and the primary one with carets, and when both sit on one row -
        //
        //   6 |     let total: i32 = "unknown";
        //     |                ---   ^^^^^^^^^ expected `i32`, found `&str`
        //
        // - taking the text after the first run made the primary span's carets part of the
        // message: "^^^^^^^^^ expected `i32`, found `&str`".
        const cm = lines[j].match(/^[^\S\n]*\|((?:[^\S\n]|[\^~|-])*[\^~-])[^\S\n]+(\S.*)$/);
        if (cm && !note && !STDLIB.test(lines[j])) note = cm[2].trim();
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
    const warnings = warningsShown(lines);
    return {
      tool: "cargo",
      summary: `${n} error${n > 1 ? "s" : ""}` +
        (warnings ? ` — ${warnings} warning${warnings > 1 ? "s" : ""} hidden` : ""),
      failures,
    };
  },
};
