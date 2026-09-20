# Changelog

## Unreleased

- A tool may say what it was doing before it says why it could not. Go writes its errors
  that way and everything built on Go writes them the same - "open /app/compose.yaml: no
  such file or directory", "creating network shop_default: permission denied" - and the
  fallback anchored on the program's name and its colon, so none of them were read.
  `docker compose` says most of its failures in that form. A few words, not a clause:
  what follows the colon still has to say that something went wrong.

- Two more words the fallback reads as a failure: `unbound` and `unterminated`. `set -u`
  is how a careful CI script is written, and the shell reports it as "deploy.sh: line 4:
  FOO: unbound variable" - nothing else in that sentence says anything went wrong, so it
  read as nothing. sed and awk say "unterminated address regex" and "unterminated
  string", and so do several compilers.

- One diagnosis read by two parsers from the same lines is reported once. Two readings
  that agree on file, line, column, title and message are one diagnosis unless the
  source line each one quotes says otherwise - which is how two cargo runs both
  reporting E0308 at `src/main.rs:2:22` stay two failures. In a log where two tools'
  lines are interleaved, though, each parser quotes whichever echo it landed next to,
  so both quotes are wrong and one diagnosis read as two. A quote now counts as
  evidence only when the two readings came from raw regions that do not overlap: the
  cargo runs are read from regions far apart, a shredded pair from the same region
  twice. Measured over ~279,000 woven fixture pairs, two pairs could be woven into a
  repeated diagnosis before this and one after - and that one is the cargo pair, whose
  two readings quote two different real source lines and are genuinely two. The corpus
  itself is byte-identical.

- `whatbroke -- python -m pytest` reads as pytest rather than as python. Naming the
  command that ran is evidence for breaking ties between parsers, ranked by where each
  tool is mentioned - and that put `python3` ahead of the module it was launching. It only
  showed where a second parser claimed the same log, which `--tb=native` does by printing
  a real Python traceback instead of pytest's own: the run came back as python's with no
  tally, worse than passing no command at all, because a piped copy of that log reads as
  pytest. The module named after `-m` is the tool. Only for an interpreter and only as its
  first argument: `pytest -m slow` selects a marker.

- Reading one log is about six times faster. Deciding which parsers to ask scans the log
  for the strings they name, and the alternation of those strings was rebuilt every time
  one was found - shrunk to what was still missing and recompiled. For a long log that
  makes the rest of the scan cheaper; for a short one the construction IS the cost, and it
  was paid several times over. The set never changes while the process lives, so it is now
  built once, and recognised by identity so that working out what to scan for is not
  redone either. Reading each capture in the corpus went from 3.1ms to 0.5ms apiece, and
  the scan alone from 1,144ms to 22ms. One 400KB log of mostly one tool's output is 7% slower,
  which is what shrinking the alternation was buying. `npm run test:heavy`, which is
  nothing but millions of short reads, goes from about seventeen minutes to three and a
  three.

- go and CMake name themselves when they refuse to run, and are read as themselves rather
  than falling to the generic reader or to nothing. go has four such sentences: a flag it
  does not have, a subcommand it does not have, one it ends by pointing at `go help`, and
  a package pattern that resolves to nothing because there is no module here - running go
  in the wrong directory, which is a CI staple. CMake has one shape: a source directory
  that is not there, one with no `CMakeLists.txt`, a generator it does not have. Its
  message sits on the banner's own line with no location, because nothing has been read
  yet, and the pattern that ends at the colon matched none of it.

- Three tools that refuse to start now say so, instead of reading as nothing. `python -m
  pytest` with pytest not installed prints the interpreter's path and the module it could
  not find, and that is the whole log of a step that never ran a test. `go` handed a flag
  it does not have prints Go's flag-package line and its own usage. `terraform` handed a
  subcommand it does not ship prints one sentence. Each is guarded by what makes it that
  tool's: the interpreter at the start of the line, go's own `usage: go <verb>` underneath
  - Go's flag package writes that first line for every program built with it - and
  terraform naming itself. Each also joins the lines the capture keeps when a log is cut
  short, because none of them carries a failure word.

- Says what the exit status means when the output says nothing. A command that is killed
  writes nothing on the way out - `cargo build` stopped by the kernel's out-of-memory
  killer, a suite cancelled by a job timeout, a crash in a C extension - and every parser
  here had nothing to read, so the answer was "whatbroke could not identify a diagnostic".
  Node reports which signal ended the process, and a signal is a fact: `137` now reads as
  SIGKILL, `139` as a segfault, and each says what usually sends it, written as the guess
  it is. Exit codes are conventions and only three are read - `127` and `126`, which a
  shell returns for a command that does not exist and one it could not run, and `124`,
  which `timeout` returns - and only for a command whatbroke ran itself. A piped log's
  upstream status never reached whatbroke and is not guessed at. A run killed part-way
  still reports whatever it managed to print, with the signal beside the diagnosis rather
  than instead of it. `--json` gains a `status` field.

- Reads `go mod`. The module loader is where a Go build fails before it compiles anything,
  and none of it was read: `go mod tidy` came back with no parser at all. Two shapes, both
  captured - a go.mod it cannot parse, reported by file and line; and a module it cannot
  get, with the reason and the chain of imports that pulled it in, nearest first, because
  the import a reader can do something about is theirs. Not a bare `go: <sentence>`:
  `go: downloading ...` and `go: warning: ...` are the same shape and are not failures,
  and nothing in such a line says which it is.

- Reads `terraform fmt -check -diff`, which is in nearly every Terraform pipeline and was
  read as nothing: the job exited 3 and the diff came back handed over whole. Each `@@` is
  a place, so one file with two unformatted regions is two of them, each at the line its
  change starts on rather than the number the hunk carries, and the source as it
  stands is quoted with each. terraform spells its diff's halves `old/<path>` and
  `new/<path>` with the same path in both, which is what tells it from git's `a/` and `b/`
  and from a test runner's `--- expected` / `+++ actual`; a file's diff ends where another
  one begins. Not a plain `terraform fmt -check`, which lists bare filenames and nothing
  else - there is no shape in a list of paths to claim safely.
- Two diffs in one pipe no longer report one place twice. `cargo fmt --check`, `gofmt -d`
  and `terraform fmt -check -diff` all read a unified diff, and a `@@` is nothing but a
  line number: read under another file's header it becomes a place in a file that has
  nothing wrong there, and where that number collides with a real one the same place was
  counted twice. A job that formats and then tests puts a format check beside minitest's
  or PHPUnit's `--- expected` / `+++ actual` / `@@`, which is all it takes. A diff's hunks
  are ordered and disjoint - each starts after the last one ended - so a hunk that does
  not is not that file's, and is refused. Every ordered pair of the corpus's diff
  captures, woven at twelve block sizes, is held to it.

- Reads `dotnet format --verify-no-changes`, the format gate most .NET CI runs. It reports
  through MSBuild in the same shape the compiler uses, so the same reader should always
  have read it - but its rule names are `WHITESPACE`, `IMPORTS` and `ANALYZERS`, and the
  code pattern required a digit, so a run that found sixteen places to fix came back as
  unrecognised output. A code is now an uppercase identifier rather than one ending in a
  digit; the file extension is still what separates these from TypeScript's identical
  `file(line,col): error TS2322:`, and no fixture in the corpus changes hands.

- Reads `gofmt -d`, the other half of Go's format gate, which was read as nothing at all.
  The file is named once in the header and each `@@` says where in it, so one file with two
  unformatted regions is two places rather than one entry, each at the line its change
  actually starts on rather than the number the hunk carries - a hunk opens with up to
  three unchanged lines of context - the same shape `cargo fmt
  --check` is read as. The source line as it stands now is quoted with each. Not `gofmt
  -l`, which is how most CI jobs run it: that prints bare filenames and nothing else, and
  nothing in a list of paths says gofmt wrote it rather than some other step. The header
  has to name one file twice - `diff x.go.orig x.go` - which is what keeps it off `git
  diff` and off a plain `diff a b`, and a file's diff ends where another one begins, so a
  job running gofmt and then a test suite does not have minitest's or PHPUnit's value diff
  read as more unformatted Go.
- A failure whose name is blank is reported without one rather than with `subject: ""`,
  which the report schema refuses. Playwright's JSON carries each test's title as a field
  and a document whose titles are empty produced exactly that; the guard is in one place
  for every parser, beside the ones that already drop a file, a line or a column that
  points at nothing.

- Reads `cargo fmt --check`, the format gate almost every Rust CI job runs. It was read as
  nothing at all: the job failed, and whatbroke said there was no parser for it and handed
  the diff back whole. rustfmt numbers the line each region it would rewrite starts at, so
  a file with three unformatted regions is three places - which is more than the other
  format checks here can say, because prettier, black and deno fmt only ever name files.
  The source line as it stands now is quoted with each one. `rustfmt --check` run directly
  prints the same thing and reads the same way; a file rustfmt cannot parse is a rustc
  diagnostic and stays cargo's, which is what the fourth capture is for.

- pytest no longer loses a failure to a name another test already has. Two tests called
  `test_total`, in different files or different classes, folded into each other because
  the short test summary was matched on the bare name - so a run reported one failure
  while its own tally said two. Each summary line now claims one failure and only one,
  and the node id it names becomes the failure's subject, which is what tells two tests
  of one name apart for `--since-last`.
- pytest no longer gives two failures the same location. `--tb=line` prints one
  `path:line: message` per failure, and these were indexed by message alone: two tests
  raising the same exception - a shared fixture breaking, which is the ordinary way this
  happens - overwrote each other and BOTH failures were reported at the last one's file
  and line, sending the reader to code that is fine. Every candidate is kept and the
  summary's own filename decides; where that cannot single one out, the failure keeps the
  file the summary named and goes without a line rather than borrowing another test's.
- A pytest block whose only words were a trailing `test_x.py:2: RuntimeError` reported an
  empty message. The pattern has three capture groups and the code read a fourth.
- A command that succeeds now writes the empty `--since-last` baseline instead of nothing
  at all. Before, a green run left yesterday's failure in the record, so when that failure
  came back it was compared against the run that first found it and called nothing new -
  the one moment a reader most wants to be told. Nothing is printed for a command that
  worked. The run identity no longer includes the tool, because a run that succeeds prints
  nothing to name a tool with; what the command was is already in its argv. Success is the
  exit code's statement and not the output's: a runner that exits zero having printed
  something readable - a suite told to tolerate a known failure, a wrapper echoing the last
  run's summary - still records that nothing is failing, in every output format, and still
  reports in full everything it read.
- Two failures whose signatures are too thin to group on are two causes in history, not
  one. `assert 1 == 2` and `assert 3 == 4` reduce to the same shape, and the display
  already refused to group them - but history keyed on that shape alone, so a second test
  failing reported "nothing new" and the first being fixed reported nothing gone. The test
  or symbol is part of the identity when the shape is that thin, and identity still
  survives the code moving to another file or line.
- A piped log is tracked only when it is named. `pytest tests/unit | whatbroke
  --since-last` and `pytest tests/api | whatbroke --since-last` carry no command at all,
  so in one directory they shared a record: each overwrote the other and each reported the
  other's failures as GONE - a claim that something was fixed, about a suite that had not
  run. An unnamed pipe is now neither compared nor recorded and says so in the terminal,
  in JSON and in the GitHub notice; `--id NAME` names a pipeline. A named pipeline also
  starts its own baseline rather than migrating a record from the previous identity
  scheme: that scheme had no `--id`, so the record sitting under a pipeline's directory
  and tool was written by some unnamed pipe, and adopting it would hand a brand-new
  pipeline another one's history and call the two compared.
- Different missing modules are different causes. `Cannot find module './a.js'` and
  `'./b.js'` were reduced to the same shape, because the path rules ate the one part of
  the message that identifies it - so three things to install became one "likely cause",
  and the reader adds one dependency, reruns, and watches two more fail. What a resolver
  says it could not find is now kept whatever it looks like.
- The wrapped command's live output honours the terminal's backpressure. `write()`
  returning false was ignored, so a command printing faster than its destination could
  read queued every later chunk in whatbroke's memory - unbounded, while `--max-bytes`
  carefully bounds the copy kept for diagnosis. The child's stream is paused until the
  destination drains.
- Comparing two runs is linear. `--since-last` scanned the whole current list once per
  remembered cause, so 40,000 causes each way took 1.3 seconds of string comparison for
  one number; it now takes 8 milliseconds.
- Paths under the working directory are shortened on Windows. The test was for the
  working directory followed by `/`, so on a platform whose separator is `\` nothing was
  ever shortened and every diagnostic showed its full absolute path.
- The exhaustive phases of `npm run test:heavy` report where they are. They take minutes,
  and a suite that prints nothing for minutes cannot be told from one that has hung.
- A command that cannot be executed is reported rather than thrown. node delivers some
  spawn failures by raising from `spawn()` itself instead of emitting `error` on the
  child, so the handler attached to the returned child never saw them: a file with no
  shebang (ENOEXEC) and an empty command name both escaped as a node stack trace under
  whatbroke's own exit code. Both now produce the same `spawn-error` report and exit 127
  that a missing command already did, and the message names the command, which the
  ENOEXEC one does not. `whatbroke -- pnpm test` found this against a stock pnpm, whose
  installed placeholder binary has no shebang. What a shebang-less file does is node's
  choice and not the same everywhere - posix_spawn reports ENOEXEC, execvp retries it
  under `/bin/sh` and runs it - so what is promised is the part that is whatbroke's:
  it never throws, stdout is always one valid report, and the report says which command
  could not start. Not what node called the reason: the same errno is `ENOEXEC` on some
  versions and `Unknown system error -8` on others.
- A located warning is recognised as an aside even when it names the rule that fired.
  The fallback already skipped `file:line: warning:` - gcc, clang, javac and go all
  write it, and a javac run that compiled cleanly once came back as "3 errors" - but the
  colon is not always the next character after the word. oxlint writes
  `shop.js:1:7: warning eslint(no-unused-vars): ...`, so an oxlint run that exited 0 on
  three warnings read as "3 errors (no parser for this tool - best guess)", while the
  same run under eslint correctly read as nothing. What may sit between the severity and
  its colon is a rule name, optionally qualified by the plugin that owns it; anything
  longer is prose, and prose after a severity word means the word was not a severity.
- `bundle install` is read. It is the first thing a Ruby CI job runs and the first thing
  that fails, and all three of the ways it fails came back as "could not identify a
  diagnostic" with the log handed back: a gem that is not there, two gems whose versions
  cannot both be had, and a `Gemfile` that will not parse. bundler writes prose rather
  than diagnostics - no severity word, no `file:line`, and a sentence that wraps
  mid-clause - so each shape is matched whole and read from a bounded region. The
  missing gem's sentence is rejoined, because the half on the second line is the one
  saying it is not installed locally either. A conflict gives the resolver's own
  explanation, which names the two gems, rather than the "version solving has failed"
  that only restates it; with no closing line the explanation is not read at all, since
  prose read to the end of a buffer is how a CI log's next tool becomes bundler's.
- A markdownlint record that lost the fields naming it is no longer reported half-read.
  What a document has to carry to be recognised as markdownlint's does not include the
  sentence describing a rule, nor a non-empty list of its names, so a cut document could
  produce a failure with no message - which the schema forbids - or one with no code.
  markdownlint names every rule twice, "MD032" and "blanks-around-lists", so the second
  name stands in when the sentence is gone, and a record with neither is dropped.
- A monorepo or CI prefix is recognised as a wrapper when it survives inside a message,
  not only when it changes the tool or the count. Every gate deciding whether a
  discovered prefix is a wrapper or the tool's own data compared the reading before and
  after it came off, and a message running over several lines defeats all of them: the
  tool is the same, the count is the same, and the stamp is still sitting on every line
  after the first. deno's JUnit reporter quotes the failing source under the message, so
  under `api:test: ` that quote read as `api:test:   if (1 + 1 !== 3) ...`. Measured over
  430 captures each wrapped in ten real CI shapes, a per-line prefix changed 25 readings
  and now changes 16; nothing is lost either way, and the corpus is byte-identical.
- golangci-lint's structured formats give a package that will not compile the same place
  its line-per-finding format does. When `typecheck` reports the compiler rather than a
  finding of its own, golangci-lint positions it at the head of the file and leaves the
  place the compiler named inside the text - so one run read three ways said shop.go:6,
  shop.go:1 and shop.go:1, with the two structured readings wrong and carrying the
  compiler's package banner in the message. The embedded place is taken only when it
  names the file the record already names, because golangci-lint quotes a compiler that
  can name any file in the package.
- A rubocop message that runs over more than one line no longer makes its whole GitHub
  Actions log read as nothing. GitHub's command syntax cannot carry a newline, so rubocop
  encodes one as `%0A` - and it writes one for every syntax offence, where the parser it
  used is named on a second line. Decoded, `.` could not cross that newline and `$` sat
  at the end of the string, so no annotation matched; a rubocop log is claimed by whether
  any offence was read at all, so the entire run came back as "could not identify a
  diagnostic". The rest of the message is now kept whole, which is what the JSON format
  already gives for the same run.

- Byte-identical CI retry blocks are collapsed before parsing. De-duplication already
  showed each diagnostic once, but 67 of 200 duplicated fixtures still changed their
  headline or another public field because parser-specific tallies counted both copies.
  A corpus-wide invariant now requires the entire public reading to remain identical.
- Launcher command hints no longer promote npm, pnpm, Yarn, Poetry, or uv above the
  actionable failure from the child they ran. Direct leaf-tool hints respect argument
  order and Windows' case-insensitive executable names, while the launcher's own
  diagnostic remains attributed as secondary output.
- Seven- and eight-bit terminal CSI and OSC controls are stripped, including cursor
  controls and OSC 8 hyperlinks. Wrapping fixture lines in those controls previously
  changed every corpus result and made 104 of 200 fixtures lose their recognized parser.
- Azure Pipelines `##[debug]` and the exact `[pod/name/container]` prefix emitted by
  `kubectl logs --prefix` are now vetted wrapper shapes. The shapes matched zero lines
  in the existing corpus before being added, and stamped logs now preserve every public
  diagnostic field across the corpus.
- CI stamps are removed from every physical line before bare-carriage-return redraws
  become logical lines. A Maven log mixing LF-delimited output with progress redraws
  otherwise fell back to one generic guess under Buildkite timestamps.
- Reads `jest --json`. Jest sends its human report to stderr and its JSON document to
  stdout, so logs that retained only stdout fell through to one generic guess. Assertion
  failures, skipped/todo/pass tallies and a suite that fails before running tests now
  agree with paired captures of Jest's human output. Several JSON documents in one job
  keep every run instead of stopping after the first.
- Retry-duplicated Go, clang and ESLint output no longer inflates the headline after
  identical diagnostics have been collapsed; hidden warnings are counted uniquely too.

- Reads flake8, pylint and black. flake8 and pylint were reaching the guess and black
  said nothing at all. pylint reports conventions and refactor suggestions alongside real
  errors, and a missing docstring listed beside an undefined variable buries it - so when
  a run has errors the advice steps aside and is counted instead. A run that found only
  conventions still failed, and still reports them.
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
