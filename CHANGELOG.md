# Changelog

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
- Added a reusable GitHub problem matcher configuration.
- Added contributor guidance for safe, fixture-backed parser additions.
- Added GitHub Actions job-summary output when `GITHUB_STEP_SUMMARY` is available.
- Hardened CI summaries against Markdown-special diagnostic text and kept non-TTY warnings ANSI-free.
- Standardized command-not-found and signal exit-code handling and documented the JSON envelope.
- Added bounded output capture with JSON truncation reporting.
- Added visible truncation warnings to terminal output.
