# whatbroke

**You ran a command. It printed 400 lines. These are the ones that matter.**

```
$ whatbroke -q pytest
```

<!-- demo.gif goes here -->

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
npm install -g whatbroke
```

Or don't install anything:

```bash
npx whatbroke pytest
```

## Use

```bash
whatbroke npm test        # run it, print the distillation after
whatbroke -q cargo build  # hide the command's own output entirely
npm test 2>&1 | whatbroke # or pipe into it
```

Exit code is passed straight through, so `whatbroke` is safe to leave in a Makefile or a CI step.

## What it reads

| Tool | What you get |
|---|---|
| **pytest** | test name, `file:line`, the assertion, the `E` explanation |
| **unittest** | same, with the deepest *your-code* frame — not the harness |
| **Python tracebacks** | the frame in your code, not the 9 in site-packages |
| **Node stack traces** | the error, the caret, your frames; `node:internal` hidden |
| **jest** | test name, `file:line`, the matcher, expected vs received |
| **vitest** | same, with the real source line — not vitest's truncated `…` version |
| **eslint** | errors only; warnings counted and set aside |
| **go test** | test name, `file:line`, the message; panics resolved past the runtime frames |
| **go build** | compile errors with source context |
| **cargo test** | test name, `file:line`, the assertion and its left/right values |
| **cargo build** | error code and the inline annotation — not the 25 lines of trait impls |
| **tsc** | errors grouped by file with source context |
| *anything else* | best-effort: lines that look like errors, marked as a guess |

Unrecognised output is never silently swallowed — you get a labelled guess, or the raw text back.

## Why it isn't an LLM

Because you already know what's wrong the instant you can see it. The problem was never comprehension, it was that the answer is on line 312 of 400. A parser that knows pytest's format is faster, free, offline, deterministic, and never invents a stack frame.

## Adding a tool

Extractors are ~40 lines and self-contained. Drop a file in `src/extractors/`, export `detect(raw)` and `extract(raw)`, add a **real** captured fixture to `test/fixtures/` and a case to `test/run.js`.

Real captured output only — no hand-written samples. Every parser in here was built against output actually produced on a real machine, which is why they work.

Wanted: `rspec`, `gradle`, `maven`, `webpack`, `clang`, `ruff`, `mypy`, `phpunit`, `dotnet test`.

## Test

```bash
npm test
```

## License

MIT
