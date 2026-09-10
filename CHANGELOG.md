# Changelog

## Unreleased

## 0.4.0 — 2026-09-10

- Reads swc. It reports through miette, the Rust diagnostic renderer, and ends with a
  tally that says nothing - which is what was being read, under node's name, losing both
  the message and the location.
- Reads Biome and oxlint, the two linters most likely to be in a new JS project. Biome
  heads each finding with the rule path and follows it with advice and a fix diff, which
  are not the diagnosis; oxlint puts the whole finding on one line with its `help:`
  suggestion appended to the message.
- Reads less and babel. Both produced no diagnosis at all. lessc puts the class, the
  message and the location on a single line with the position as prose at the end; babel
  embeds the file in the middle of its message and follows the code frame with twenty
  frames of its own parser, which is the bulk of the log.
- A `cargo run` panic is no longer reported as `cargo test`. A panic is a test failure
  only when a test run produced it - a tally at the end, or a per-test stdout block above
  it - and a program that panicked on its own has neither. The fixture that showed this
  has said `Running target/debug/m2` since the day it was captured.
- `terraform init` is read rather than guessed at. It draws no box - it writes the error
  flat with the prose under it and no location, because nothing has been parsed yet - and
  it is the first command anyone runs.
- A Python file that will not compile is read rather than guessed at. It produces no
  traceback and no frames, just the location the parser gave up at - a traceback frame's
  shape without the ", in <name>" a frame always carries. It stands beside any tracebacks
  in the same log rather than instead of them.
- A tool's own line prefix is no longer mistaken for a wrapper. npm leads every line of
  its output with "npm ", and in a log where npm was not the only tool, taking that off
  left npm's parser matching nothing and handed the log to whoever was next. A strip that
  destroys the reading already there is not an improvement, however different the tool
  that inherits it.
- Reads sass, webpack and prettier. sass puts its message at the head of a drawn box and
  the location at the foot, so reading the first line found the problem and never where
  it was. webpack follows each error with the resolver's entire search - forty lines of
  how it looked rather than what went wrong - and that trace is now dropped. prettier
  --check exits non-zero while naming only files, so the failure said nothing at all.
- Reads stylelint and node-tap. Both produced no diagnosis at all. stylelint reports
  like eslint but marks severity with a glyph rather than a word, so eslint's own parser
  did not see it. node-tap emits TAP 14 with an `at:` block where `node --test` writes
  `failureType` and a flat `location`; each parser now checks that shape per block, so a
  job that ran both keeps every failure and neither reads the other's.
- Reads jasmine and markdownlint. Both produced no diagnosis at all. jasmine gathers
  its failures under a "Failures:" heading with a labelled message and stack; its own
  frames name no file, so they cannot be mistaken for yours.
- Numbered failure blocks are now bounded to the section that owns them. "N) name" is
  written by jasmine, mocha, rspec, PHPUnit and Playwright alike, so a log holding two
  of them had each parser reading the other's blocks - jasmine's "Message:" line ends in
  a colon, which is exactly what mocha writes a test name as. jasmine reads between its
  heading and its tally, mocha reads after its tally and stops at the count it declared,
  and PHPUnit stops where its run ends.
- Reads ava. Like mocha, a failing run produced no diagnosis at all. ava lists what
  failed and then details each one under a rule, so the roll-call carries the names and
  the detail blocks carry the locations. A comparison reports its diff, an assertion that
  is not one reports its prose and the value under it, and a throw is located from its
  stack rather than from ava's own pointer.
- Reads mocha. A failing `mocha` run produced no diagnosis at all: not a worse answer,
  nothing. It numbers its failures under a tally and splits each over two lines, the
  suite on the numbered line and the test indented under it - a shape rspec and
  Playwright share, so the tally is what identifies the tool. Assertion failures, hook
  failures, timeouts and a file that will not load are all read; a timeout reports no
  location rather than a frame inside node's own timers.
- A discovered line prefix no longer swallows the log's own indentation when that
  indentation sits in the middle of it. A log that is mostly stack frames shares the
  frames' indentation and what follows, so the prefix came out as `api:test:     at `
  and stripping it took the frames apart.

- A prefix with no vetted shape — `kubectl logs -f` naming the pod, `docker compose`
  naming the service — is now recovered on a log of any length. The length floor that
  guarded prefix inference cost ten fixtures their parser under one of those, and the
  same ten under a CI stamp layered over a monorepo runner; refusing a strip that does
  not demonstrably improve the parse is the guard that actually does the work, and a
  one-line failure inside a runner's prefix is exactly the log whose whole diagnosis is
  that line. A prefix inside a carriage-return redraw blob remains unrecoverable, because
  a single physical line offers nothing to compare against.
- A wrapper that a parser swallowed is now removed. Perl writes its location as prose at
  the end of the message rather than as an anchor at the start, so it parsed straight
  through a runner prefix — and the prefix then defeated the de-duplication that joins
  its two lines, reporting two failures where a clean log reports one.
- Source ranges are located on demand rather than for every parser that claims the text.
  A single-tool log computed all of them and read none: 90 ESLint problems inside a
  100,000-line build log cost 4.5s, now 0.48s. Every range across 124 mixed logs is
  byte-identical to the eager version.
- `sameSourceDiagnostic` compares message text before asking for a source range, since
  both must hold and asking is what forces the location work. ESLint, tsc and Jest in a
  100,000-line log: 2.0s to 0.45s, with identical output across all 15,252 ordered pairs.

- Mixed-log ownership is now exact across all 13,414 ordered cross-parser fixture
  pairs. Failures carry private source ranges so two parsers cannot report the same raw
  diagnostic region, without changing terminal output or the version-1 JSON schema.
- Tightened parser boundaries found by the exact sweep: Node and Python now retain
  independent exception blocks, and Bun, Cargo, Deno, ESLint, mypy, PHP, pnpm, Ruff and
  Swift stop claiming or borrowing another tool's diagnostic text.
- CI-stamped progress redraws using bare carriage returns are normalised without losing
  their parser. The invariant now covers 868 fixture/stamp combinations.
- Recorded 22 fresh failing commands across 11 installed tool families as the 0.4.0
  release gate; all were parsed by their expected tool.

- Large captures now keep bounded windows around probable diagnostics between the head
  and tail, so a real failure cannot disappear merely because cleanup output followed it.
- Replaced persistent 32-bit fingerprints with 96-bit SHA-256 prefixes. The last v4
  `--since-last` record migrates without marking unchanged causes as new; disappearance
  claims are conservatively withheld during that one transition.

- Added a package-boundary smoke test: CI now builds the npm tarball, installs it into
  a clean temporary project without network access, runs both installed command shims,
  and parses a real captured failure through the installed package.

- Fixed: Buildkite's `--timestamp-lines` prefix prevented most captured logs from
  reaching their parser; its bracketed local timestamp is now removed before analysis.

- Fixed mixed-log echo filtering: rebuild clusters after removing duplicates so retained failures keep valid indices and terminal output cannot crash.
- Fixed distinct diagnostics disappearing when they share a location with the primary tool, or when neither has a location. Tightened Ruff, Cargo and Yarn matches exposed by retaining those diagnostics.
- Fixed `--since-last` overlooking secondary tools. History now tracks causes from every reported tool and marks new secondary failures; older history records start a fresh baseline.

- Fixed: git reported cargo's "could not compile … due to 3 previous errors" — a tally
  cargo itself suppresses — as a git failure, and kubectl reported deno's
  "error: Test failed" as a kubectl one. `error:` and `fatal:` at line start belong to
  half the tools in existence; ordering protects the winning parser from that, but the
  mixed-log path asks every parser anyway.

- Added a Terraform parser. Its diagnostics are drawn in a box, and the vertical bar down
  the left is part of the drawing rather than the message — so a validation failure came
  back as the headline alone, with the file, the line and the sentence explaining it all
  left inside the box.

- Added CMake and kubectl parsers. A CMake configure failure — a missing source, a parse
  error in the script — produced no diagnosis at all; nor did `kubectl get` against an
  unreachable cluster, which prints five identical klog lines and then the sentence a
  person actually wants.
- ninja deliberately gets no parser: what fails under it is a compiler, which already has
  one, and ninja's own `FAILED: [code=1]` line restates the failure without adding to it.

- Added a Playwright parser. A run with two failures came back as three, two of which
  were the paths of artifact files to go and open, and the second real failure was
  missing entirely.

- Added a pyright parser. Its diagnostics were readable only as a guess, which took the
  column for the start of the message, dropped the indented line that says why, and never
  saw the rule name.

- A parser's headline is now asserted to say that something went wrong, over every
  fixture. Four parsers had shipped a tally that read like success over a real failure —
  jest's `0 total`, vitest's `no tests`, rspec's `0 examples, 0 failures`, PHPUnit's
  `0 failures` on a run that errored — each found and fixed one at a time.

- Fixed: a .NET build with no project file, and one with a package that will not restore,
  both produced no diagnosis at all. MSBuild and NuGet report these with a code but no
  position, and requiring a position meant two of the commonest .NET failures went unread.
- Fixed: a Maven build that could not resolve a dependency produced no diagnosis.
  Everything Maven reports that is not a compiler diagnostic is a failed goal, and there
  was no branch for one.

- Fixed: PHPUnit heads an escaped exception "There was 1 error", not "1 failure", and
  only the failure wording was read — so an uncaught exception in a test, at least as
  common as a failed assertion, fell through to the guess as three errors for one
  failure. Its tally also reported only failures, saying "0 failures" over a run that
  errored.
- Fixed: a PHPUnit test file that throws while loading produced no diagnosis at all.
- Fixed: an RSpec file that raises while loading is reported as prose above the tally
  rather than as a numbered example, and was not read. Its tally begins "0 examples,
  0 failures", which alone reads like success.

- Fixed: a vitest suite that throws before declaring a test is listed under "Failed
  Suites" with the file in brackets rather than a test name after a chevron, and only
  the chevron form was read — so a file that will not even import fell through to the
  guess. Its headline also read "no tests", which over a real failure looks like success.
- Fixed: `node --test` reported `test failed` for a suite that crashed on import, which
  is what TAP says and says nothing. The real error is printed above as TAP comments.

- A crash outside a test run now reports where it happened. bun, deno, PHP and Ruby all
  print a message and then say where, on the next line or inside the message, and only
  the message was being read. A Ruby crash produced no diagnosis at all, because Ruby
  names the method between the location and the message so there is no space after the
  line number.
- Fixed: PHP writes a fatal error twice, to the error log and to stdout, and both were
  counted — so the run appeared to fail twice as badly as it had.
- Fixed: a wrapper prefix was never stripped from a log only the fallback could read, so
  the prefix ended up inside the message and defeated that de-duplication.

- Fixed: ruff reported nothing at all for a file it could not parse. A syntax error is
  reported without a rule code, and requiring one meant a run saying "Found 1 error."
  came back with none — the ordinary case of running ruff over a file with a typo.
- Fixed: ruff's summary said "1 errors".
- Fixed: mypy reported a problem with its own invocation, such as an unreadable file, as
  an unparsed guess.

- Fixed: a `go run` panic produced no diagnosis at all. Its output has no test tally and
  no `--- FAIL` line, so nothing in the detector fired.
- Fixed: a Node syntax error reported a location inside `node:internal/modules/…` rather
  than the file with the syntax error. When every stack frame is the runtime's own, the
  header above the caret is where the real location is.
- Fixed: when even that header is a runtime file, no location is reported at all —
  pointing at `node:internal/modules/esm/resolve` reads as though the bug were in node.
- Fixed: ESM reports paths as `file://` URLs, so source context could never be read for
  a module and the location was printed as a URL.

- Fixed: a plain `cargo run` panic produced no diagnosis at all — the most common Rust
  failure there is. The panic pattern is matched line by line and so carries no `m`
  flag, which meant using it for detection only ever tested the first line of the log.
- Fixed: a cargo build-script failure reported "failed to run custom build command",
  the mechanism, while the panic naming the file and line sat indented underneath it.
- Fixed: a dependency that cannot be resolved never reaches the compiler, so there is no
  error code or location for detection to key on, and cargo did not recognise its own
  output.

- Fixed: tsc dropped every error that has no `file(line,col)` prefix, so a broken
  tsconfig reporting three errors came back with two and said nothing about the third.
- Fixed: a jest suite that throws before any test runs made the headline read
  `0 total`, which looks like nothing happened. The suite tally is used instead.
- Fixed: a broken eslint config makes eslint crash, and the failure was reported at a
  line inside eslint's own internals. The configuration error is reported instead.
- Fixed: a wrapper prefix could be swallowed into a filename rather than stripped —
  `api:test: tsconfig.json` — leaving the log partly read. A prefix whose removal
  recovers more failures is now stripped even when the same parser wins either way.
- Fixed: the clustering fingerprint was not canonical for nested quoting, so two
  spellings of one message could fail to meet.

- Fixed: the fallback's pattern for `Error:` required a capital E, so a tool writing it
  lower produced no diagnosis at all. `jq: parse error: …` and openssl's
  `…:error:09FFF06C:PEM routines:…` both came back empty; both are now surfaced as the
  labelled guess they are.
- A log whose diagnostic lines contain GitHub workflow commands is now covered by a test
  on the parsed path as well as the fallback path.

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
