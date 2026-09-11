# 0.4.0 release evidence

Status: unpublished release candidate. The fresh-command minimum and current automated
gates pass, but the reliability audit remains open. Do not publish, tag, create a GitHub
release, or update the bundled Action pin until the audit is deliberately closed.

## Fresh command gate

Run on 2026-09-10 on macOS 26.6.2 arm64. Each command was launched through the local
`whatbroke --json` CLI. The command's non-zero status was preserved in every case.
Temporary paths and the deliberately invalid package name are local test data.

| # | Family and version | Failing command shape | Expected parser | Extracted | Outcome |
|---:|---|---|---|---:|---|
| 1 | Node 22.23.2 | `node node-type.js` (null method call) | node | 1 | pass |
| 2 | Node 22.23.2 | `node node-reference.js` (missing binding) | node | 1 | pass |
| 3 | npm 12.0.2 | `npm run absent` | npm | 1 | pass |
| 4 | npm 12.0.2 | `npm exec --offline <uncached-package>` | npm | 1 | pass |
| 5 | Python 3.12.8 | `python3 py-key.py` | python | 1 | pass |
| 6 | Python 3.12.8 | `python3 py-value.py` | python | 1 | pass |
| 7 | Cargo 1.98.0 | `cargo check --manifest-path <crate>` | cargo | 1 | pass |
| 8 | Cargo 1.98.0 | `cargo test --manifest-path <crate>` | cargo test | 1 | pass |
| 9 | Deno 2.9.5 | `deno run deno-runtime.ts` | deno | 1 | pass |
| 10 | Deno 2.9.5 | `deno check deno-check.ts` | deno check | 1 | pass |
| 11 | Ruby 2.6.10 | `ruby ruby-method.rb` | ruby | 1 | pass |
| 12 | Ruby 2.6.10 | `ruby ruby-key.rb` | ruby | 1 | pass |
| 13 | PHP 8.5.10 | `php php-fatal.php` | php | 1 | pass |
| 14 | PHP 8.5.10 | `php php-parse.php` | php | 1 | pass |
| 15 | Perl 5.34.1 | `perl perl-syntax.pl` | perl | 1 | pass |
| 16 | Perl 5.34.1 | `perl -e <undefined-subroutine>` | perl | 1 | pass |
| 17 | Swift 6.2.3 | `swiftc -typecheck swift-type.swift` | swift | 1 | pass |
| 18 | Swift 6.2.3 | `swiftc -typecheck swift-call.swift` | swift | 1 | pass |
| 19 | CMake 4.4.3 | `cmake -S <missing-source> -B <build>` | cmake | 2 | pass |
| 20 | CMake 4.4.3 | `cmake -S <parse-error> -B <build>` | cmake | 1 | pass |
| 21 | Go 1.27.1 | `go run go-panic.go` | go | 1 | pass |
| 22 | Go 1.27.1 | `go test ./...` | go test | 1 | pass |

Result: 22 failing commands across 11 tool families passed, exceeding the 20-command,
10-family minimum.

## Follow-up dogfooding

Run on 2026-09-11 on the same macOS host. This pass targeted machine-readable modes
and current command shapes that were not represented by the original gate.

| Family and version | Failing command shape | Expected parser | Extracted | Outcome |
|---|---|---|---:|---|
| Terraform 1.16.1 | `terraform validate -json` | terraform | 1 | miss fixed in `3859ff7` |
| Terraform 1.16.1 | `terraform validate -no-color` | terraform | 1 | miss fixed in `3859ff7` |
| Swift 6.2.3 | `swiftc -parseable-output -typecheck bad.swift` | swift | 2 | corrupt result fixed in `3859ff7` |
| Cargo 1.98.0 | `cargo check --message-format=json` | cargo | 1 | pass |
| .NET SDK 10.0.400 | `dotnet build --no-restore` | dotnet | 2 | pass |
| Go 1.27.1 | `go test ./...` | go test | 1 | pass |
| Go 1.27.1 | `go test -json ./...` | go test | 1 | pass |

The Terraform and Swift fixes use paired real captures and assert field-for-field parity
with their human-readable forms. Before the fix, Terraform JSON was unrecognized,
boxless Terraform text was lost, and Swift returned one corrupted failure instead of
two. The full capture gate then exposed a fourth regression: pretty JSON buried in a
large log was cut mid-document. Structured diagnostic windows now preserve it under
the same 120 KB cap used for every corpus fixture.

## Misses and dispositions

- `npm run boom`, whose script only called `process.exit(7)`, emitted two npm notice
  lines and no diagnostic. whatbroke correctly preserved exit 7 and returned its
  bounded `unrecognized-output` fallback. It is not counted above because there is no
  failure text for a parser to extract.
- `perl -e 'die <arbitrary text>'` likewise emitted arbitrary prose with no error shape.
  whatbroke preserved exit 255 and returned the fallback. The undefined-subroutine run
  replaced it in the counted gate.
- The first `go test` attempt could not write the host Go build cache in the restricted
  test environment. It was rerun with `GOCACHE` inside the temporary workspace and then
  parsed exactly as `go test`; the environmental setup failure is not counted.
- A Buildkite timestamp around a bare-CR redraw blob made the fresh Python traceback
  unreadable and changed Swift's extracted details. The fix was verified against the
  prior implementation, then generalized into a regression sweep of 868 combinations
  across every fixture and seven CI stamp formats.

## Automated gates

- Ten local suites: pass.
- Detector matrix: 204 fixtures, no ownership changes; the four additions are the
  paired Terraform and Swift captures above.
- Ordered mixed-log sweep: 38,126 cross-parser pairs, exact recovery.
- Interleaving sweep: 20,706 streams, no crash or duplicate diagnosis; 678 same-tool
  ordered pairs retain both runs.
- Capture sweep: all 204 fixtures survive burial in 3 MB of chatter and a 120 KB cap.
- Normalization sweep: 2,648 logs across nine CI stamps and four literal prefixes;
  1,836 stamped bare-carriage-return redraw blobs.
- Fuzz: 164,016 parser calls, no crash, stall, or warning promoted to failure.
- Packed-install smoke test: pass; the offline tarball install and both command shims
  parsed a real captured fixture.
- CI run 34575352400: pass on Linux, macOS, and Windows with Node 18, 20, 22, and 24
  (12 jobs) for commit `3859ff7`.

The changelog remains Unreleased, and the README Action example stays on the published
`0.1.1`. The bundled Action also remains pinned to `0.1.1`. Finalizing those values is
release work, not reliability-audit work.
