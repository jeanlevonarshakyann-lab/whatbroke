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

Extractors should return `{ tool, summary, failures }`. A failure may include
`file`, `line`, `col`, `title`, `message`, and parser-specific context fields.
Warnings, notes, framework internals, and summary counters should not become
failures unless they are actionable diagnostics.

## Safety and quality

- Run `npm test` before submitting changes.
- Keep source reads confined to the working directory.
- Never add network calls or runtime dependencies for a parser.
- Add malformed-input coverage when a parser has ambiguous or multiline syntax.
- Do not include secrets or private source code in fixtures.

## Requesting a parser

Include the tool name, version, operating system, a redacted failing output
sample, and the expected concise result. Redact secrets before posting logs.
