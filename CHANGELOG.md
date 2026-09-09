# Changelog

## Unreleased

- Added a git parser. A merge conflict reported "Automatic merge failed" — the mechanism
  — while the `CONFLICT` lines naming the files were dropped; a rejected push reported
  "failed to push some refs" under five lines of `hint:`. Both now report what happened
  and to which file or ref.
- Fixed: a failure with a file but no line rendered as `a.txt:?`, which invents a
  question the log never asked. A merge conflict is about the whole file.

- Fixed: one failure read two ways was reported as two. A Python traceback's
  `KeyError: 'x'` is also a shape Node's parser recognises, so the same failure arrived
  twice — once located, once not. The second reading is now dropped.
- Fixed: cargo scanned forward without limit for a diagnostic's location, so in a log
  holding two tools an `error:` line belonging to another tool could adopt an unrelated
  location. rustc puts the `-->` on the very next line, every time.

- Fixed: the Docker BuildKit handling did not work on real Docker output. Docker writes
  `ERROR: failed to build: failed to solve:`, not `ERROR: failed to solve:`, so the
  failure block was never found; and a real build log carries image-pull progress, so
  the step prefix covers far less of it than a synthetic sample suggests.
- Fixed: pip's catch-all claimed Docker's own `ERROR: failed to build: …` line as a pip
  failure, so every failing build with a `pip install` step reported one that never
  happened.

- A failing `docker build` reported `ERROR: failed to solve: …`, which names the
  mechanism and not the cause. The step's own output is now read instead, either from
  BuildKit's `#8 0.234 ` stamps or from the failure block Docker quotes above that line.
- Stacked wrappers are peeled a layer at a time. Removing only the outer one is often no
  improvement by itself, so a greedy search gave up before reaching the layer that pays.

- Added `test/fuzz.js`: a seeded mutation fuzzer that cuts, duplicates, reverses and
  corrupts every captured fixture and requires that no parser throws or stalls on the
  result. 19,488 parser calls per run.

## 0.3.0 — 2026-09-09

Everything below has been sitting unreleased: npm still serves 0.1.1, and 0.2.0 was
version-bumped but never published, so its entries ship here too.

- Fixed: a compiler driver error with no source to point at — a missing input file, a
  failed link — carried no `file:line` and so fell through to the labelled guess, which
  then also reported make's `*** [target] Error 1` echo as a second failure. Driver
  errors are now read by the clang parser, and `no input files`, which only restates the
  error above it, is dropped.

- Added `test/guarantees.js`, which pins exit-code fidelity across every output mode and
  asserts that a failed command is never presented as anything else — including when its
  own output claims success, and when there is no output at all.

- Added pnpm and yarn parsers. Both produced no diagnosis at all before, despite being
  among the most-run commands in a JavaScript project.
- Fixed: the whitespace class introduced when parsers stopped backtracking across
  newlines matched only a space and a tab, so a tool indenting with any other kind of
  whitespace was invisible. pnpm indents with U+2009 THIN SPACE. The class is now
  `[^\S\n]`, which cannot cross a line either and is exactly as fast, but matches every
  kind of space a tool might print.

- Fixed: a tool that does not own the log could contribute a failure with no location
  and no identifier, which is a stray match on another tool's text far more often than a
  finding. bun prints `error: expect(received).toEqual(expected)` and cargo's `^error:`
  claimed it, so a bun log showed a fourth cargo compile error that does not exist. The
  winning tool is never filtered this way.
- Fixed: an npm failure with no code declared nothing about itself, so it was treated as
  an unanchored claim and vanished from a mixed log entirely.

- Fixed: the vite parser treated any bracketed uppercase word as a rollup diagnostic
  code, so an interleaved `[INFO]` or `[WARN]` line from another tool became a build
  error. Diagnostics are now read only after vite says the build failed, and log-level
  names are excluded.

- Added esbuild and vite/rollup parsers. Both bundlers print their real diagnostic and
  then their CLI wrapper reports that the bundler exited non-zero; whatbroke was reading
  the second one, so an esbuild syntax error came back as
  `Command failed: …/esbuild --bundle` pointing at `node:internal/errors`, with the
  actual error nowhere on screen.
- Fixed: a wrapper's stack no longer surfaces as a second tool's failures in a mixed
  log. A failure located entirely in node internals is the same failure told worse.

- Added a pip parser. A failing build printed 42 lines and the best guess available was
  `error: subprocess-exited-with-error`; it now reports the exception the build backend
  actually raised. A resolution failure that pip states twice, pads with two `Ignored the
  following` lines and the entire package index, becomes one failure with the requirement
  named. A malformed requirements file reports its own file and line.

- Parsers declare their own `category` and the commands that imply them, and failures
  carry that category. Everything a parser needs to say about itself now lives in its
  own file.
- When whatbroke launches the command, the command is used as detection evidence: a
  named tool is tried first, including through a wrapper such as `npx`. It only
  reorders, so naming the wrong tool cannot damage a log that is already unambiguous,
  and piped logs are unaffected.

- Failures now declare what they are: `tool`, `code`, `subject`, `label` and `severity`
  alongside the existing fields. `title` is unchanged, so `--json` and the GitHub
  annotation shape are unaffected. Severity was already computed by seven parsers and
  thrown away; it is now reported, and warnings still never become failures.
- Clustering no longer consults a hand-maintained table of 27 tool names to learn what a
  tool's `title` meant. The policy follows the failure's own fields, so a new parser
  cannot get wrong grouping by omission.
- `--since-last` records from before this change are ignored rather than compared
  against, which would have reported every cause as newly appeared.

- A log holding more than one tool's output now yields every tool's failures, not just
  the winner's. They were already being extracted and then discarded: an eslint-plus-jest
  log reported 2 failures out of 92 and a line saying the other 90 existed. `failures`
  still means what the winning tool reported; the rest arrive under `others`, grouped by
  their own tool and annotated individually in `--format github`.

- Fixed: a log relayed through a line-prefixing runner — Turborepo, Docker BuildKit,
  pnpm, kubectl — produced no diagnosis at all, because every parser anchors on the start
  of a line. Uniform prefixes are now detected and removed, and reported on the result.
  A prefix is only removed when removing it lets a real parser find something it could
  not find before, so a tool's own uniform prefix (`npm error `, mypy's repeated source
  directory) is left intact.

- Fixed: a log containing a long run of blank or whitespace-only lines took tens of
  seconds to analyse. `\s` matches a newline, so a line-anchored pattern like
  `/^\s+at /m` consumed every remaining newline at each blank line and then backtracked
  looking for the rest — quadratic in the number of lines. Eight extractors spent five to
  seventeen seconds each on one such input. Quantified `\s` in these patterns is now
  `[ \t]`, which cannot cross a line. 50,000 blank lines went from 10.1 s to 7 ms.

- Fixed: capture kept the head of a large log and discarded the rest, losing exactly the
  part that explains a failure. A 1.8 MB log with a pytest failure at the end reported no
  diagnostic at all. The byte budget is now spent from both ends, with an explicit marker
  naming what was dropped.
- Fixed: slicing at the capture limit re-encoded already-decoded chunks and cut them at
  arbitrary byte offsets, splitting multi-byte characters. Cuts now land on line
  boundaries, which cannot fall inside a UTF-8 sequence.
- Added a detector collision matrix (`test/detectors.js`) recording, for every fixture,
  which parsers claim it, which one wins, and how many failures each losing claimant
  would have extracted. A new parser that reaches into an existing fixture now fails the
  suite immediately.

- Added `--since-last`: marks the causes that were not present the last time the same
  command ran. Compares only within one command, tool and directory; withholds the
  "no longer reported" count when the run was truncated or never started, and does not
  record such a run at all. State lives in the OS cache directory, never the project,
  and a cache that cannot be read or written never changes a run's outcome.

- Fixed: explicit stdin marker `-` remains supported; GitHub fallback annotations use a bounded preview while job summaries retain captured output.

- Fixed: unrecognized piped output is preserved, and failed commands without parsed diagnostics report their exit status and available raw context in terminal, JSON, and GitHub Actions modes.
- Added version-1 JSON fields `inputMode`, `commandExitCode`, and `fallback` to distinguish unknown upstream status from success and expose unrecognized captured output.
- Fixed: invalid CLI options and values exit `2` before the command starts; large fallback output drains completely, and GitHub summary-write errors no longer replace the command's exit code.
- Fixed: source containment was enforced on the unresolved path, so a symlink inside
  the working directory — or a symlinked parent — could make whatbroke read and print
  a file from anywhere on disk. Both sides are now canonicalised, which also fixes a
  working directory reached through a link rejecting its own files.
- Source reads are now bounded before allocation: size is read from the descriptor
  and files over 2 MiB are skipped.
- Long source lines are narrowed for display only, by a window that follows the
  reported column, so the caret marks the offending code instead of sitting thousands
  of spaces past it. Staleness is still compared against the whole line: clipping
  first would report an edit past the cut as no edit at all.
- Only regular files are read, opened non-blocking, so a directory, device or FIFO
  named in a log can no longer stall the run.

- Fixed: standalone javac diagnostics route to the JVM parser, and Gradle compiler warnings are excluded from failures.
- Fixed: .NET diagnostics no longer require a restore banner; mypy detection preserves `.py` and `.pyi` diagnostics with optional columns and no summary.
- Fixed: `--no-source` retains statements captured in the log without reading source files.
- Fixed: signal exit codes use the platform's signal numbers, including exit code 137 for `SIGKILL`.
- Fixed: Node assertion boilerplate could group unrelated numeric failures as one likely cause.
- Fixed: nested Node test suites emitted duplicate parent failures alongside their failing tests.
- Group failures that share a likely cause, and lead with the number of causes
  rather than the number of failures. Deterministic fingerprinting, no model.
- Report `clusters` in `--json` as a partition of `failures`, which is unchanged.
- Added `--no-cluster`.
- The GitHub job summary and the run's notice line now lead with likely causes
  instead of listing every failure flat. Annotations are unchanged: one per failure.
- Fixed: annotation messages escaped `:` as `%3A`, which the runner does not decode
  in a message body, so `KeyError: 'exp'` displayed as `KeyError%3A 'exp'`.
- Fixed: pytest `-q` totals were missed, so a run reporting "85 failed" was
  summarised as a count of parsed blocks.
- Fixed: a single very long boilerplate line (pytest listing every fixture) was
  printed in full.

## 0.2.0

- Added stable `--json` output with exit-code preservation.
- Added `--format terminal|json|github`.
- Added clickable GitHub Actions annotations.
- Added a reusable composite action at `.github/actions/whatbroke`.
- Added `--version` and Node 18 support.
- Added `--no-source` for logs and environments where source context should not be read.
- Added a first-class `mypy` diagnostic parser.
- Added a first-class GCC/Clang compiler diagnostic parser.
- Added a first-class RSpec failure parser.
- Added Maven and Gradle JVM compiler diagnostics.
- Added .NET compiler diagnostics.
- Added a first-class PHPUnit failure parser.
- Hardened PHPUnit summary boundaries, .NET project metadata handling, Clang detection, and Gradle Java diagnostics.
- Added a reusable GitHub problem matcher configuration.
- Added contributor guidance for safe, fixture-backed parser additions.
- Added GitHub Actions job-summary output when `GITHUB_STEP_SUMMARY` is available.
- Hardened CI summaries against Markdown-special diagnostic text and kept non-TTY warnings ANSI-free.
- Standardized command-not-found and signal exit-code handling and documented the JSON envelope.
- Added bounded output capture with JSON truncation reporting.
- Added visible truncation warnings to terminal output.
