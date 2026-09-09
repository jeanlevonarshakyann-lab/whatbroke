# Changelog

## Unreleased

- Fixed: unrecognized piped output is preserved, and failed commands without parsed diagnostics report their exit status and available raw context in terminal, JSON, and GitHub Actions modes.
- Added version-1 JSON fields `inputMode`, `commandExitCode`, and `fallback` to distinguish unknown upstream status from success and expose unrecognized captured output.
- Fixed: invalid CLI options and values exit `2` before the command starts; large fallback output drains completely, and GitHub summary-write errors no longer replace the command's exit code.
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
