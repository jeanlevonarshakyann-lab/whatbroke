# 0.4.0 release evidence

Status: release candidate. Do not publish, tag, create a GitHub release, or update the
bundled Action pin until every gate below is green.

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
- Detector matrix: 124 fixtures, no ownership changes.
- Ordered mixed-log sweep: 13,414 applicable cross-parser pairs, exact recovery.
- Interleaving sweep: 7,626 streams, no crash or duplicate diagnosis.
- Fuzz: 59,520 parser calls, no crash, stall, or warning promoted to failure.
- Packed-install smoke test: pass; the offline tarball install and both command shims
  parsed a real captured fixture.
- CI: pending Linux, macOS, and Windows on Node 18, 20, 22, and 24.

The README continues to show the published `0.1.1` Action version and this changelog
remains Unreleased until the pending CI gate passes.
