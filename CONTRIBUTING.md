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
   Keep detection specific enough that existing fixtures do not cross-detect.
6. Add the tool to the README support table and changelog.

An extractor declares itself: `{ name, category, commands, detect, extract }`, where
`category` is one of `test`, `lint`, `typecheck`, `compile`, `build`, `runtime`,
`package`, `vcs` or `unknown`, and `commands` lists the command names that imply it.

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

## Requesting a parser

Include the tool name, version, operating system, a redacted failing output
sample, and the expected concise result. Redact secrets before posting logs.
