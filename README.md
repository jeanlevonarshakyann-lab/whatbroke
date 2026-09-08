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

Exit code is passed straight through, so `whatbroke` is safe to leave in a Makefile or a CI step.

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

When GitHub provides `GITHUB_STEP_SUMMARY`, the same mode also adds a compact
Markdown report to the job's Summary tab.

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
| **node --test** | test name, `file:line`, and the assertion out of TAP's YAML block |
| **Node stack traces** | the error, the caret, your frames; `node:internal` hidden |
| **jest** | test name, `file:line`, the matcher, expected vs received |
| **vitest** | same, with the real source line — not vitest's truncated `…` version |
| **eslint** | errors only; warnings counted and set aside |
| **go test** | test name, `file:line`, the message; panics resolved past the runtime frames |
| **go build** | compile errors with source context |
| **cargo test** | test name, `file:line`, the assertion and its left/right values |
| **cargo build** | error code and the inline annotation — not the 25 lines of trait impls |
| **cargo clippy** | the lint name as the title, so you know what to fix or allow |
| **ruff** | rule code, `file:line`, the message and ruff's own fix hint |
| **mypy** | error code, `file:line`, the type-checking message; notes and warnings set aside |
| **GCC/Clang** | compiler errors with `file:line:column`; warnings and notes set aside |
| **RSpec** | example name, failure message, and `spec/file:line` location |
| **Maven/Gradle** | JVM compiler errors, Surefire test failures, and build scripts that fail to evaluate |
| **.NET** | compiler error codes with `file:line:column`; warnings set aside |
| **dotnet test** | test name, `file:line`, the assertion; reflection frames dropped |
| **PHPUnit** | test name, assertion message, and `file:line` location |
| **tsc** | errors grouped by file, with the assignability chain down to the real reason |
| *anything else* | best-effort: lines that look like errors, marked as a guess |

Unrecognised output is never silently swallowed — you get a labelled guess, or the raw text back.

Repeated identical diagnostics are shown once. Distinct tests or diagnostics
that happen to share a file and line are preserved.

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

Nothing is hidden: `failures` is unchanged in `--json` and every annotation is still
emitted in `--format github`. Grouping only decides which failures the terminal
spends its five slots on. `--no-cluster` turns it off everywhere.

Source context is read from the file on disk. If the file has changed since the command
ran — you edited it, or you piped in saved output — whatbroke says so and shows the line
the tool itself reported, rather than confidently pointing a caret at the wrong code.

## Safety

whatbroke reads source context from disk to show you the lines around a failure.
Output can come from anywhere — a pasted log, a CI artifact, someone else's machine —
so it will only ever read files **inside the directory you ran it in**. Crafted output
naming `/etc/passwd` or `~/.ssh/id_rsa` gets the error printed, never the file.

It runs your command without a shell (`spawn`, not `sh -c`), so nothing in a filename
or argument is expanded. It has zero dependencies and makes no network calls.

It writes to disk in exactly one case: when `GITHUB_STEP_SUMMARY` is set — which
GitHub Actions sets for you — `--format github` appends a run summary to that file.
Nowhere else, and never outside CI unless you set that variable yourself.

## Why it isn't an LLM

Because you already know what's wrong the instant you can see it. The problem was never comprehension, it was that the answer is on line 312 of 400. A parser that knows pytest's format is faster, free, offline, deterministic, and never invents a stack frame.

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
