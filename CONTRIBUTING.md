# Contributing

## Adding a parser

1. Capture real output from the tool on a failing run. Do not hand-write a
   fixture that only resembles the tool output.
2. Remove usernames, absolute home directories, repository names, tokens,
   URLs with credentials, and other sensitive values while preserving syntax.
3. Add the capture to `test/fixtures/` with a descriptive `_fail.txt` name.
4. Add a focused case to `test/run.js` covering the tool name, failure count,
   location, title, message, and summary.
5. Add the extractor to `src/extractors/` and register it in `src/index.js`.
   Keep detection specific enough that existing fixtures do not cross-detect, and
   bound what `extract` reads — see "Bound what a parser reads" below.
6. Add the tool to the README support table and changelog.

An extractor declares itself: `{ name, category, commands, detect, extract }`, where
`category` is one of `test`, `lint`, `typecheck`, `compile`, `build`, `runtime`,
`package`, `vcs`, `deploy` or `unknown` (`unknown` belongs to the fallback alone), and `commands` lists the command names that imply it.

Extractors should return `{ tool, summary, failures }`. A failure may include
`file`, `line`, `col`, `title`, `message`, and parser-specific context fields.

A failure should also say what it is. Set exactly one of `code` (a diagnostic
identifier), `subject` (the name of the site that failed) or `label` (a constant the
tool prints for a class of failure), plus `severity`. Grouping depends on this: a `code`
identifies a problem and stays in the fingerprint, while a `subject` is the axis being
grouped across and never enters it. Setting none means the failure clusters on its
message alone, which is safe but inert.
Warnings, notes, framework internals, and summary counters should not become
failures unless they are actionable diagnostics.

## Bound what a parser reads

This is the mistake this codebase makes most often, and detection is not where it
happens. `detect` decides whether a parser is asked at all; `extract` then reads the
whole log unless it is told not to. In a log holding two tools — which is the ordinary
case in CI — that means reading the other tool's output.

The markers are not distinctive. `error:` is written by cargo, deno, git, kubectl,
sass, terraform and half the rest. `N) name` is written by jasmine, mocha, rspec,
PHPUnit and Playwright. `not ok` by tap and `node --test`. `file:line:col:` by every
compiler there is. A parser that scans for one of those across a whole log will find
somebody else's.

Bound the scan with something the tool itself declares:

- a **count** — mocha says `2 failing`, so it reads two blocks and stops
- a **section** — jasmine's blocks live between `Failures:` and its tally; PHPUnit's
  between `There were N failures:` and where its run ends
- **adjacency** — deno writes `error:` on the line under its header, rustc puts `-->`
  on the line after, vitest's assertion is one line below `FAIL`
- **the very next thing it said** — `terraform init` narrates what it is doing, so its
  error is the first line after the last step, and nothing further down is its

A distance window is usually still too loose: a dozen lines was enough for terraform to
reach past its own output into sass's. Prefer a structural bound over a numeric one.

Two rules that fall out of the same problem:

- A diagnostic cannot own a stack that another diagnostic stands in front of. Stop a
  frame search at the next error line, not merely after N lines.
- A tool's own line prefix is not a wrapper. npm leads every line with `npm `, and
  stripping it leaves npm's parser matching nothing.

`test/mixed.js` is what catches all of this: it concatenates every ordered pair of
fixtures and asserts the combination recovers exactly the failures the two recover
apart. It is at zero and should stay there. A new parser that breaks it has not been
bounded.

## Safety and quality

- Run `npm test` before submitting changes. `test/guarantees.js` runs first and pins the
  two promises everything else is subordinate to: the exit code is the command's own,
  and a command that failed is never presented as anything else. If a change makes those
  fail, the change is wrong, not the test.
- A parser's `summary` must say that something went wrong. A tool's own tally often does
  not: jest prints `Tests: 0 total` when a suite throws before declaring one, and rspec
  prints `0 examples, 0 failures`. Both were real headlines over real failures, and both
  read as though nothing had happened. `test/guarantees.js` asserts this over every
  fixture.
- Keep source reads confined to the working directory.
- Never add network calls or runtime dependencies for a parser.
- Add malformed-input coverage when a parser has ambiguous or multiline syntax.
- Do not include secrets or private source code in fixtures.
- Rewrite the capturing machine's paths to `/home/dev` before committing a fixture. A temp
  or scratch directory, or a home directory with a username in it, is not tool output -
  and because a path never changes what a log reads as, nothing else in the suite will
  notice one left behind. `test/detectors.js` checks for it. Change the paths and
  nothing else.

## Requesting a parser

Include the tool name, version, operating system, a redacted failing output
sample, and the expected concise result. Redact secrets before posting logs.
