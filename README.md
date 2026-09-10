# whatbroke

**You ran a command. It printed 400 lines. These are the ones that matter.**

![whatbroke turning 38 lines of pytest output into 20](https://raw.githubusercontent.com/jeanlevonarshakyann-lab/whatbroke/main/demo/demo.gif)

```
  ✗ 3 failed, 2 passed in 0.01s

  test_shop.py:4  test_invoice_total
    assert 1049 == 1050
    +  where 1049 = total([1000, 49], 0.5)

      2 │ def total(items, tax): return sum(items) + int(tax)
      3 │ def test_invoice_total():
      4 │     assert total([1000, 49], 0.5) == 1050
      5 │ def test_expired_token():

  test_shop.py:7  test_expired_token
    KeyError: 'exp'

      5 │ def test_expired_token():
      6 │     tok = {"sub": "u1"}
      7 │     assert tok["exp"] == 1
```

No LLM. No API key. No network. Just parsers that know what each tool's output looks like.

Real reductions, measured on the fixtures in this repo:

| | before | after |
|---|---|---|
| `cargo build` | 51 lines | 10 |
| `vitest` | 59 lines | 12 |
| `pytest` | 40 lines | 20 |
| `jest` | 37 lines | 9 |
| `go test` | 22 lines | 12 |
| `node -e` | 15 lines | 4 |

## Install

```bash
npm install -g @jeanlevon/whatbroke
```

Or don't install anything:

```bash
npx @jeanlevon/whatbroke pytest
```

Either way the command is `whatbroke` (or `wb`).

## Use

```bash
whatbroke npm test        # run it, print the distillation after
whatbroke -q cargo build  # hide the command's own output entirely
npm test 2>&1 | whatbroke # or pipe into it
whatbroke --json npm test # emit a stable result for CI and editor integrations
whatbroke --github-actions npm test # add clickable errors to GitHub Actions logs
whatbroke --format github npm test # equivalent long-form format selector
whatbroke --no-source npm test # show failures without reading source files
whatbroke --max-bytes 2000000 npm test # bound captured logs for large CI jobs
```

When wrapping a command, its exit code is passed straight through, so `whatbroke`
can be left in a Makefile or a CI step. Piped input does not carry the upstream
command's exit status: whatbroke exits `0` after processing it, which does not mean
the upstream command succeeded. Wrap the command when you need its exit status.
An optional `-` supports explicit piped input (`cmd | whatbroke -`).

Unknown options and invalid option values exit `2` without starting the command.
Options belong before the command; its own arguments are passed through unchanged.
Use `--` to explicitly end whatbroke's options. `--max-bytes` takes a decimal
integer of at least 1024.

If a failed command produces no recognized diagnostic, whatbroke reports its exit
code and shows captured output (or points to output already streamed above).
If nothing was captured, it says so. Unrecognized piped text is also shown, with
the upstream status labelled unknown. In GitHub Actions, failed commands get an
error annotation and a summary; unrecognized pipes get a notice rather than an
assumed command failure. Captured output remains subject to `--max-bytes` and is
labelled incomplete when truncated. GitHub fallback annotations show a preview
capped at 3,500 encoded bytes; job summaries and JSON retain the captured output.

Use `whatbroke --help` for all options. `--json` suppresses the wrapped command's
output so stdout remains valid JSON, and emits a versioned envelope with
`tool`, `summary`, `guessed`, `exitCode`, and `failures` fields. It is intended
for CI wrappers and scripts. The wrapped command's stderr remains available on
stderr for debugging.

Output capture is bounded to 10 MiB by default. Use `--max-bytes` to tune the
limit; JSON reports `"truncated": true` if the limit was reached. Live terminal
output is still streamed normally.

Use `--no-source` when logs come from another machine, contain untrusted paths,
or when a CI job should not read the checkout after the command finishes. The
failure location, statement, and parser message are still shown.

### GitHub Actions

Keep the raw command available in the job log while adding a compact failure
summary to the step:

```yaml
- name: Test
  run: npx --yes @jeanlevon/whatbroke npm test
```

To turn parsed failures into clickable annotations in the Actions UI:

```yaml
- name: Test with annotations
  run: npx --yes @jeanlevon/whatbroke --github-actions npm test
```

When GitHub provides `GITHUB_STEP_SUMMARY`, the same mode also writes a report to the
job's Summary tab. That report leads with the likely causes, one section each, with
their sites folded behind a disclosure — the same shape the terminal prints. Failures
that were not grouped follow it, so the summary stays a complete account of the run.

For workflows that prefer GitHub's problem matcher protocol, add
`.github/whatbroke.problem-matcher.json` with:

```yaml
- run: echo "::add-matcher::.github/whatbroke.problem-matcher.json"
- run: npx --yes @jeanlevon/whatbroke --quiet npm test
```

For scripts that need to inspect the result without parsing terminal formatting:

```yaml
- name: Test (JSON)
  run: npx --yes @jeanlevon/whatbroke --json npm test > whatbroke.json
```

The JSON envelope is versioned and has this shape:

```json
{
  "version": 1,
  "tool": "pytest",
  "summary": "1 failed, 2 passed",
  "guessed": false,
  "exitCode": 1,
  "inputMode": "command",
  "commandExitCode": 1,
  "fallback": null,
  "truncated": false,
  "error": null,
  "failures": [
    {
      "file": "tests/test_shop.py",
      "line": 12,
      "col": 5,
      "title": "test_total",
      "message": "assert 1049 == 1050"
    }
  ]
}
```

`tool`, `summary`, `col`, and `error` may be `null` or omitted when the input
does not provide them. Consumers should use `version` to handle future schema
changes. Spawn failures set `error` and use exit code `127`.

The following fields are additive to version 1; existing fields retain their meaning:

- `inputMode` is `"command"` or `"pipe"`.
- `commandExitCode` is the wrapped command's shell-compatible exit code, or `null`
  for piped input and commands that could not be started. The existing `exitCode`
  remains whatbroke's process exit code, including `0` for processed pipes and
  `127` for spawn failures.
- `fallback` is `null` for recognized diagnostics, successful commands, and empty
  pipes. Otherwise it contains `reason` (`"unrecognized-output"`, `"no-output"`,
  or `"spawn-error"`), a human-readable `message`, and `rawOutput` containing the
  captured text. `rawOutput` can be empty. Check the top-level `truncated` field
  before treating captured text as complete; spawn error details remain in `error`.

An empty `failures` array means no diagnostics were extracted. It does not establish
command success: check `commandExitCode`, and treat `null` as unknown.

Repositories can use the bundled composite action:

```yaml
- uses: jeanlevonarshakyann-lab/whatbroke/.github/actions/whatbroke@main
  with:
    command: npm test
    version: 0.2.0
```

Pin `version` to a known npm release for reproducible CI. The action preserves
the command's exit status and emits file/line annotations when a parser finds
them.

## What it reads

| Tool | What you get |
|---|---|
| **pytest** | test name, `file:line`, the assertion, the `E` explanation |
| **unittest** | same, with the deepest *your-code* frame — not the harness |
| **Python tracebacks** | the frame in your code, not the 9 in site-packages |
| **deno test** | test name and `file:line` from the header, without the assert-library frames |
| **deno run** | the exception class, `file:line:col` and your frames — the message without `error:` and without the `file://` scheme |
| **deno check** | the `TS` code, the explanation and the location — not the `error: Type checking failed.` tally underneath them |
| **bun test** | test name, `file:line`, the matcher — not bun's echoed source |
| **bun** | a runtime crash read as bun's rather than node's, keyed on the version bun stamps at the foot of one |
| **node --test** | test name, `file:line`, and the assertion out of TAP's YAML block |
| **Node stack traces** | the error, the caret, your frames; `node:internal` hidden |
| **Playwright** | the test name, the line that actually threw, and the offending expression — not the paths to its artifact files |
| **jest** | test name, `file:line`, the matcher, expected vs received |
| **vitest** | same, with the real source line — not vitest's truncated `…` version |
| **eslint** | errors only; warnings counted and set aside |
| **go test** | test name, `file:line`, the message; panics resolved past the runtime frames, and `-race` reports at the racing line |
| **go build** | compile errors with source context |
| **go vet** | the location, which sits inside the message when vet reports a package that will not compile |
| **cargo test** | test name, `file:line`, the assertion and its left/right values |
| **cargo build** | error code and the inline annotation — not the 25 lines of trait impls |
| **cargo clippy** | the lint name as the title, so you know what to fix or allow |
| **ruff** | rule code, `file:line`, the message and ruff's own fix hint |
| **pyright** | the rule name as the code, the column, and the indented line that says *why* — not the column pasted into the message |
| **mypy** | error code, `file:line`, the type-checking message; notes and warnings set aside |
| **Terraform** | the file, the line, the block, and the sentence at the bottom of the box that says what to do |
| **CMake** | the script line and the command that raised it — `add_executable`, `find_package` |
| **ninja** | no parser of its own: what fails under it is a compiler, which already has one |
| **kubectl** | the sentence a person wants, not five identical klog lines from inside client-go |
| **GCC/Clang** | compiler errors with `file:line:column`; driver errors that never got as far as a file; warnings and notes set aside |
| **Swift** | the diagnostic and the `[#group]` tag as its code — not the annotation swiftc draws underneath, which repeats the message word for word |
| **make** | no parser of its own — the compiler underneath already has one, and `make: *** [target] Error 1` restates the failure without adding to it |
| **RSpec** | example name, failure message, and `spec/file:line` location |
| **Ruby** | the exception class, the line that raised, and the unwind — for a missing gem, the line that asked for it rather than `kernel_require.rb` |
| **Perl** | the location, which Perl writes as prose at the end of the message; `near "= ;"` kept, the `@INC` list dropped, warnings told apart from a fatal die by what they say |
| **javac / Maven / Gradle** | JVM compiler errors with warnings excluded, Surefire test failures, and build scripts that fail to evaluate |
| **.NET** | compiler error codes with `file:line:column`; warnings set aside |
| **dotnet test** | test name, `file:line`, the assertion; reflection frames dropped |
| **PHPUnit** | test name, assertion message, and `file:line` location |
| **PHP** | the exception class and the stack; PHP writes every diagnostic twice, and you get it once |
| **esbuild** | the diagnostic and its source line — not the CLI wrapper's `Command failed:` stack |
| **vite / rollup** | the rollup error code, `file:line:col` and the offending line |
| **tsc** | errors grouped by file, with the assignability chain down to the real reason |
| **git** | the conflicted files, not "Automatic merge failed"; the rejected ref, not five lines of `hint:` |
| **npm** | its own failures — a missing script, a bad engine — without the trailing advice |
| **pnpm** | its error code and message — indented with a thin space, which is why it needed one |
| **yarn** | the failure without the documentation link that follows it |
| **pip** | the exception a build backend actually raised, not `subprocess-exited-with-error`; resolution failures once rather than twice, without the package index pasted in |
| **a log stamped by CI** | GitHub Actions and `gh run view --log`, Jenkins' Timestamper in either form, `docker logs --timestamps`, journald — the stamp comes off before anything reads the log |
| *anything else* | best-effort: lines that look like errors, including plain unix ones like `curl: (7) Failed to connect`, marked as a guess |

Unrecognised output is never silently swallowed — you get a labelled guess, or the raw text back.

A CI job usually runs a linter, then a typechecker, then the tests, and pastes all of
it into one log. Only one parser can own that output, but every tool's failures are
extracted and shown, each under the tool that found it:

```
  ✗ 2 failed | 12 passed (14)
    this log also contains failures from eslint (90), tsc (5), shown below

  shop.test.js:3  invoice total
    AssertionError: expected 1049 to be 1050

  — eslint 90 problems (90 errors, 0 warnings)
    5 likely causes, 52 sites

  lib/adapters/fetch.js:133  eqeqeq  (22 cases)
    Expected '!==' and instead saw '!='
```

Each tool's failures are grouped using its own vocabulary, and in `--format github`
every one of them gets an annotation, with the tool named when it is not the one that
owns the log. In `--json`, `failures` still means what the winning tool reported —
unchanged — and the rest arrive under `others`.

The same diagnosis is never reported twice: unittest prints its failures *as* Python
tracebacks, and that is one failure read two ways, not two failures. Two different tools
flagging the same line for different reasons are both kept, because they are.

A tool that does not own the log has to say where its failure is, or what it is — a
diagnostic with no location and no identifier is a stray match on somebody else's text
far more often than a finding. The tool that *does* own the log is never filtered that
way, so `error: linking with cc failed`, which has neither, is still the answer when
cargo owns the output.

One failure read two ways is not two failures. A Python traceback ends
`KeyError: 'taxrate'`, and Node's parser recognises that shape too — so the second
reading is dropped, because it says strictly less: its message sits inside the other's
and it knows less about where the failure is.

One honest limit remains: parsers are asked about the whole log rather than the region
they own, so in a concatenated log a parser can still match a fragment of another tool's
output. Every combination that actually co-occurs in a CI job is exact; the residue is
arbitrary pairs — a Rust build log next to a PHPUnit run — where a named second tool may
show one failure too many. The winning tool's diagnosis is never affected.

Closing it properly means each parser reporting which lines its findings came from.
Deriving that from the text instead was tried and measured: 99% of failures can be
located that way, and it removes about a third of the residue, which is not enough to
call it solved. What it did find is the residue's real cause — parsers with a loose
`error:` pattern reaching into another tool's output — and those are worth fixing one at
a time as they turn up.

CI stamps every line — GitHub Actions prefixes an ISO timestamp, and `gh run view --log`
puts the job and step in front of that. Every parser here anchors on the start of a line,
so a stamped log would match nothing at all. whatbroke strips a uniform prefix before
parsing, and only when nearly every line carries one, so a log that merely mentions a
timestamp is left exactly as it is. Paste a CI log straight in.

Repeated identical diagnostics are shown once. Distinct tests or diagnostics
that happen to share a file and line are preserved.

## What a failure is

Every failure carries what it is, not just a display string:

| field | meaning |
|---|---|
| `tool` | which parser produced it |
| `code` | a diagnostic identifier — `TS2551`, `no-unused-vars`, `E0308` |
| `subject` | the name of the site that failed — a test name, a method |
| `label` | a constant the tool prints for a class of failure — `compile error` |
| `category` | `test`, `lint`, `typecheck`, `compile`, `build`, `runtime`, `package`, `vcs` |
| `severity` | `error` or `warning`; warnings never become failures |
| `file` `line` `col` `message` `stmt` `trace` | as before |

`code`, `subject` and `label` are alternatives — a parser declares whichever it actually
found, and never two. `title` is unchanged and still carries the display string, so
anything reading it keeps working.

This is what makes grouping work without a lookup table. A `code` is the identity of a
problem, so it stays in the fingerprint and the echoed source line drops out — the same
lint in forty places is one thing to fix. A `subject` is the axis being grouped across,
so it never enters the fingerprint and the failing expression stays as the discriminator.
Until recently that decision was a hand-maintained table mapping 27 tool names to what
their `title` happened to mean.

## One bug, or eighty?

Change one string in a library and eighty tests fail. They are one bug. Every tool
in this space will show you the first five and let you work out the rest.

whatbroke groups failures that share a likely cause and leads with the count:

```
  ✗ 85 failed, 1973 passed, 25 skipped in 3.58s
    2 likely causes, 14 sites (+15 others)

  tests/test_basic.py:642  test_choice_argument_none  (+9 more sites)
    assert "Error: Missing argument" in "...Failure: Missing argument"
      also tests/test_options.py:1951
```

**Over-splitting is cheap; over-merging is fatal.** Split one cause in two and you
read an extra block. Merge two causes into one and you fix the exemplar, rerun, and
watch the rest still fail — after which the "likely cause" line is worth nothing
anywhere. So the grouping refuses whenever it is unsure, and it is designed to be
able to say nothing at all.

It is deterministic — an exact fingerprint, no similarity score, no model. A fuzzy
threshold would let the same suite report a different number of causes run to run,
and "these share this signature" is something you can check by eye in a way that
"these scored 0.72" is not.

What keeps it honest:

- Quoted text that is short and has no spaces is a **name** and is kept, so
  `KeyError: 'exp'` never merges with `KeyError: 'sub'`. Longer quoted text is data
  and is abstracted away.
- A path must prove itself with separators or a known extension, so `cart.total` is
  never mistaken for a filename.
- A signature carrying fewer than two real words is refused outright — forty
  unrelated `assert 1 == 2` failures do not become "one likely cause".
- Three sites minimum. Two failures sharing a shape is usually coincidence.

Nothing is hidden: `failures` is unchanged in `--json`, and `--format github` still
emits one annotation per failure — each one is a marker on a line in the diff view, and
dropping one would hide a line. Grouping only decides what leads: the terminal's five
slots, the job summary's sections, and the run's notice line. `--no-cluster` turns it
off everywhere.

Source context is read from the file on disk. If the file has changed since the command
ran — you edited it, or you piped in saved output — whatbroke says so and shows the line
the tool itself reported, rather than confidently pointing a caret at the wrong code.

## What changed since last time

`--since-last` marks the causes that were not there the last time you ran the same
command, so a wall of red you have already read does not look the same as a wall that
just grew.

```console
$ whatbroke --since-last pytest

  ✗ 3 failed, 2 passed in 0.01s
    1 new since your last run
    1 from that run is no longer reported

  test_shop.py:7  test_expired_token  new
    KeyError: 'aud'
```

A cause is identified by the same fingerprint the grouping uses, so it survives moving
to another file, another line, or another position in the output — and two different
bugs never collapse into one.

Runs only ever compare against runs of **the same command, for the same tool, in the
same directory**. `pytest tests/unit` and `pytest tests/api` do not cover the same
code, so a cause missing from one is not a cause that got fixed; they keep separate
histories and never meet.

For mixed logs, the primary tool identifies the run, and comparison includes every
reported tool's causes. New failures are marked in their own tool's section; identical
messages from different tools keep separate identities. Older history records that
only tracked the primary tool are ignored, so the first run after upgrading establishes
a fresh baseline.

The two claims are not equally cheap. "New" is a statement about what is present, and
it is safe. "No longer reported" is a statement about *absence*, and absence is only
evidence when the run actually got far enough to speak — so it is withheld whenever the
capture was truncated or the command never started. For the same reason a run like that
is never recorded: storing its short list would make the next run announce everything it
lost as newly appeared.

Nothing about tracking can change the outcome of a run. If the cache cannot be read or
written, whatbroke says nothing about history and prints the same diagnosis it always
would.

## When something else is printing your log

Turborepo puts `api:test: ` in front of every line. Docker BuildKit puts `#12 1.234 `.
pnpm names the package and script, kubectl names the pod. Every parser here anchors on
the start of a line, so before whatbroke understood these, a wrapped pytest run produced
*nothing* — not a worse answer, no answer at all.

whatbroke finds the prefix and removes it, then says which one it removed, because
knowing the failure came from `api:test:` is worth keeping.

Nothing is stripped on a hunch. A candidate prefix is removed only if removing it makes
a real parser find something it could not find before — so npm's `npm error ` and mypy's
repeated source directory, which look exactly like wrappers, are left alone. The
invariant is not "strip prefixes", it is "never come out worse than going in", and it is
tested by wrapping every captured fixture in every runner's prefix and requiring the same
tool and the same failures out the other side.

Docker gets the same treatment. A failing `docker build` ends with
`ERROR: failed to solve: process "/bin/sh -c npm test" did not complete successfully`,
which names the mechanism and not the cause — the cause is the step's own output, either
under BuildKit's `#8 0.234 ` stamps or quoted in the block above that line. whatbroke
reads whichever is there and hands it to the tool that actually failed.

Wrappers stack, too: a monorepo runner relaying a container relaying a test run is peeled
a layer at a time, and each layer is named on the result.

One known limit: a tool that redraws a progress line with a bare carriage return packs
many logical lines into one physical line. A runner stamps that blob once, so after the
carriage returns are normalised most of the interior lines carry no prefix and the
uniformity check correctly declines to act.

## When the log is too big

`--max-bytes` caps how much output is kept (10 MB by default). The cap is spent from
both ends: a slice of the beginning, where the command line and build banner live, and
as much of the end as the rest of the budget allows — because the lines that say *why*
something failed are almost always the last ones printed.

What is dropped is stated, never silently stitched:

```
~~~ whatbroke: 1743102 bytes of output elided here (raise --max-bytes to keep them) ~~~
```

Cuts land on line boundaries, so a parser is never handed half a line, and multi-byte
characters are never split.

## Safety

whatbroke reads source context from disk to show you the lines around a failure.
Output can come from anywhere — a pasted log, a CI artifact, someone else's machine —
so it will only ever read files **inside the directory you ran it in**. Crafted output
naming `/etc/passwd` or `~/.ssh/id_rsa` gets the error printed, never the file.

Containment is enforced on the *canonical* path, so a symlink inside the tree pointing
somewhere else — or a symlinked parent directory — is refused rather than followed. A
working directory that is itself reached through a link still reads its own files.

Reads are bounded before anything is allocated: the size is taken from the open
descriptor and files over 2 MiB are skipped. Lines are read whole and narrowed only for
display — a 200-character window that slides to wherever the reported column is, so the
caret stays beside the code it marks instead of a screen of spaces away from it. Only
regular files are read, and they are opened non-blocking, so a directory, socket, device
or FIFO named in a log cannot stall the run. Any of these refusals drops the snippet and
keeps the diagnostic — you still get the error, just no source under it.

One honest limit: the check resolves the path and then opens it, so a sufficiently
determined attacker who can already write inside your working directory could swap a
directory component in between. `O_NOFOLLOW` narrows that window but does not close it.
Anyone with that access could simply put the content in a real file instead.

It runs your command without a shell (`spawn`, not `sh -c`), so nothing in a filename
or argument is expanded. It has zero dependencies and makes no network calls.

It writes to disk in exactly two cases, both of which you have to ask for. When
`GITHUB_STEP_SUMMARY` is set — which GitHub Actions sets for you — `--format github`
appends a run summary to that file. And `--since-last` records a list of fingerprints
under your OS cache directory (`WHATBROKE_CACHE_DIR` overrides it). Never inside your
project, never anywhere else, and never at all unless you pass the flag or set the
variable.

## Why it isn't an LLM

Because you already know what's wrong the instant you can see it. The problem was never comprehension, it was that the answer is on line 312 of 400. A parser that knows pytest's format is faster, free, offline, deterministic, and never invents a stack frame.

## When whatbroke runs the command itself

`whatbroke vitest` tells whatbroke which tool is about to fail, and that is evidence no
line of the log can contradict. Each parser declares the commands that imply it, and a
named tool is tried first — including through a wrapper, so `npx vitest run` and
`./node_modules/.bin/vitest` both count.

It only reorders. The parser still has to recognise the output and find something, so
naming a tool that did not produce the log changes nothing, and piped logs — which carry
no command — behave exactly as before.

## Adding a tool

Extractors are ~40 lines and self-contained. Drop a file in `src/extractors/`, export `detect(raw)` and `extract(raw)`, add a **real** captured fixture to `test/fixtures/` and a case to `test/run.js`.

Real captured output only — no hand-written samples. Every parser in here was built against output actually produced on a real machine, which is why they work.

Wanted: `webpack`.

## Test

```bash
npm test
```

## License

MIT
