import pytest from "./extractors/pytest.js";
import { traceback, unittest } from "./extractors/python.js";
import node from "./extractors/node.js";
import nodetest from "./extractors/nodetest.js";
import bun, { bunRuntime } from "./extractors/bun.js";
import denoRuntime from "./extractors/denorun.js";
import denoLint, { denoFmt } from "./extractors/denolint.js";
import deno from "./extractors/deno.js";
import tsc from "./extractors/tsc.js";
import jestjson from "./extractors/jestjson.js";
import jest from "./extractors/jest.js";
import mochajson from "./extractors/mochajson.js";
import mochaxunit from "./extractors/mochaxunit.js";
import mocha from "./extractors/mocha.js";
import ava from "./extractors/ava.js";
import jasmine from "./extractors/jasmine.js";
import tap from "./extractors/tap.js";
import taptext from "./extractors/taptext.js";
import playwright from "./extractors/playwright.js";
import vitest from "./extractors/vitest.js";
import eslintjson from "./extractors/eslintjson.js";
import eslint from "./extractors/eslint.js";
import ruff from "./extractors/ruff.js";
import flake8 from "./extractors/flake8.js";
import rubocop from "./extractors/rubocop.js";
import golangci from "./extractors/golangci.js";
import pylint from "./extractors/pylint.js";
import markdownlint from "./extractors/markdownlint.js";
import stylelint from "./extractors/stylelint.js";
import shellcheck from "./extractors/shellcheck.js";
import yamllint from "./extractors/yamllint.js";
import oxlint from "./extractors/oxlint.js";
import biome from "./extractors/biome.js";
import sass from "./extractors/sass.js";
import webpack from "./extractors/webpack.js";
import less from "./extractors/less.js";
import babel from "./extractors/babel.js";
import swc from "./extractors/swc.js";
import prettier from "./extractors/prettier.js";
import black from "./extractors/black.js";
import mypy from "./extractors/mypy.js";
import pyright from "./extractors/pyright.js";
import clang from "./extractors/clang.js";
import swift from "./extractors/swift.js";
import ruby from "./extractors/ruby.js";
import minitest from "./extractors/minitest.js";
import perl from "./extractors/perl.js";
import php from "./extractors/php.js";
import cmake from "./extractors/cmake.js";
import terraform from "./extractors/terraform.js";
import rspec from "./extractors/rspec.js";
import jvm from "./extractors/jvm.js";
import junitjvm from "./extractors/junitjvm.js";
import dotnet from "./extractors/dotnet.js";
import dotnettest from "./extractors/dotnettest.js";
import phpunit from "./extractors/phpunit.js";
import gojson from "./extractors/gojson.js";
import govetjson from "./extractors/govetjson.js";
import gotest from "./extractors/gotest.js";
import cargo from "./extractors/cargo.js";
import cargojson from "./extractors/cargojson.js";
import { esbuild, vite } from "./extractors/bundler.js";
import git from "./extractors/git.js";
import kubectl from "./extractors/kubectl.js";
import docker from "./extractors/docker.js";
import make from "./extractors/make.js";
import npm from "./extractors/npm.js";
import { pnpm, yarn } from "./extractors/pkgmanager.js";
import pip from "./extractors/pip.js";
import generic from "./extractors/generic.js";
import { stripAnsi, stripCiPrefix, isNoise, collapseRepeats } from "./util.js";
import { clusterFailures } from "./cluster.js";
import { readers } from "./router.js";
import { stripRedrawnCiPrefix, wrapperCandidates } from "./normalize.js";
import { joinSources, preserveSourceRange, rangesOverlap, setLines, setParser, sourceRange } from "./ownership.js";

// order matters: most specific first, generic last
export const EXTRACTORS = [pytest, nodetest, bun, bunRuntime, deno, denoRuntime, denoLint, denoFmt, playwright, jestjson, jest, mochajson, mochaxunit, mocha, ava, jasmine, rubocop, tap, taptext, vitest, unittest, traceback, eslintjson, eslint, ruff, pylint, flake8, golangci, markdownlint, stylelint, shellcheck, yamllint, biome, oxlint, black, prettier, sass, less, webpack, babel, swc, pyright, mypy, cmake, terraform, swift, clang, minitest, ruby, perl, php, rspec, junitjvm, jvm, dotnettest, dotnet, phpunit, cargojson, cargo, govetjson, gojson, gotest, esbuild, vite, node, tsc, git, kubectl, docker, make, npm, pnpm, yarn, pip, generic];

/** Whether two readings each quote the offending source line, and quote different ones.
 *
 *  A quoted line is optional - one reporter keeps it and another of the same run does
 *  not - so its absence proves nothing and every comparison below ignores it. Its
 *  presence on both sides does prove something. Two cargo runs in one log each said
 *  "mismatched types" at src/main.rs:2:22, one under `let total: i32 = "not a number";`
 *  and one under `let count: i32 = "several";`, and they were reported as one: file,
 *  line, column, code and message all matched, and the one field that told them apart
 *  was the one nothing compared. */
function quoteDiffers(a, b) {
  const quote = (f) => String(f.stmt ?? "").trim().replace(/\s+/g, " ");
  return !!quote(a) && !!quote(b) && quote(a) !== quote(b);
}

/** A failure's location as a report promises it: a file with a name, and a line and a column
 *  that count from 1. A parser writes what the log says, and a damaged log can say
 *  `file:0:0`, or put a problem above the heading that names its file - which points at
 *  nothing, so it is not passed on. A column without its line points at nothing either.
 *  The corpus holds every parser to the same promise before this is reached; see
 *  test/report.js. */
function located(failure) {
  const { file, line, col } = failure;
  const fileOk = file === undefined || (typeof file === "string" && file.length > 0);
  const lineOk = line === undefined || (Number.isInteger(line) && line >= 1);
  const colOk = col === undefined || (Number.isInteger(col) && col >= 1 && lineOk && line !== undefined);
  if (fileOk && lineOk && colOk) return failure;
  const copy = { ...failure };
  if (!fileOk) delete copy.file;
  if (!lineOk) delete copy.line;
  if (!lineOk || !colOk) delete copy.col;
  return preserveSourceRange(failure, copy);
}

function dedupeFailures(failures) {
  // Collapsing here rather than in each parser puts it on every failure that reaches the
  // reader, from every parser, and it happens before the key is built - so two failures
  // that differ only in how many times they repeated themselves also dedupe.
  const normalized = failures.map((f) => (f.message
    ? preserveSourceRange(f, { ...f, message: collapseRepeats(f.message) })
    : f));
  const seen = new Map();
  const unique = [];
  for (const failure of normalized) {
    // `stmt` is optional context for rendering, not part of a diagnosis's identity.
    // Two reporters can preserve the same failure while only one keeps the offending
    // source line. Counting those as separate made one crash appear twice in a shredded
    // JUnit/spec stream. Keep one copy, preferring the one that can show the source.
    const key = JSON.stringify([
      failure.file ?? null, failure.line ?? null, failure.col ?? null,
      failure.title ?? "", failure.message ?? "",
    ]);
    const candidates = seen.get(key) ?? [];
    const index = candidates.find((i) => !quoteDiffers(unique[i], failure));
    if (index === undefined) {
      seen.set(key, [...candidates, unique.length]);
      unique.push(failure);
    } else if (!unique[index].stmt && failure.stmt) {
      unique[index] = joinSources(failure, unique[index]);
    } else {
      unique[index] = joinSources(unique[index], failure);
    }
  }
  return unique;
}

/** Whether two paths name one file: the same path, or a path and a longer one that ends
 *  with it. A report prints `/home/dev/shop/test/cart.test.js` where the console printed
 *  `test/cart.test.js` - vitest's TAP and JSON do, and so does jest's JSON. */
function sameFile(a, b) {
  const x = String(a).replace(/\\/g, "/"), y = String(b).replace(/\\/g, "/");
  return x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`);
}
const fileName = (path) => String(path).split(/[\\/]/).pop();

/** Two parsers may label the same diagnostic differently. Require both a real
 * location and matching message, allowing a code printed as a trailing suffix.
 *
 * A location is a file, and a line where either has one. A suite that failed to load
 * has no line in any of the formats that report it, and the same file and the same
 * words are then the same failure. */
function sameLocatedDiagnostic(a, b) {
  if (!a.file || !b.file || !sameFile(a.file, b.file) || (a.line ?? null) !== (b.line ?? null)) return false;
  if (a.col && b.col && a.col !== b.col) return false;
  if (a.code && b.code && a.code !== b.code) return false;
  if (quoteDiffers(a, b)) return false;
  const message = (f) => {
    let text = String(f.message ?? "").trim();
    for (const code of [a.code, b.code].filter(Boolean)) {
      const suffix = ` [${code}]`;
      if (text.endsWith(suffix)) text = text.slice(0, -suffix.length).trimEnd();
    }
    // eslint's table trims the full stop a rule ends its message with, as
    // `message.replace(/([^ ])\.$/u, "$1")`, and its JSON report keeps it. One run printed
    // both ways says the same thing twice, and only the full stop told them apart.
    return text.replace(/([^ ])\.$/u, "$1");
  };
  const text = message(a), other = message(b);
  if (!text.length || !other.length) return false;
  if (text === other) return true;
  // One reporter prints the diff under an assertion and another stops at the assertion:
  // mocha's spec and xunit reporters write `4 !== 6` and then `-4` and `+6`, and its JSON
  // report writes the first two lines alone. The same test at the same place, whose
  // message is the other's with lines added under it, is the same failure told at more
  // length. Whole lines, so a message that merely begins the same way is not taken.
  const [shorter, longer] = text.length < other.length ? [text, other] : [other, text];
  if (!a.title || a.title !== b.title) return false;
  if (longer.startsWith(`${shorter}\n`)) return true;
  // A console summary names what an exception said and not what it was: Surefire's
  // `CartTest.totalsAnInvoice:9 expected: <6> but was: <4>` is its report's
  // `org.opentest4j.AssertionFailedError: expected: <6> but was: <4>` without the class.
  return longer.replace(/^[\w.$]*(?:Error|Exception)[\w$]*:[^\S\n]+/, "") === shorter;
}

// How many pairs of readings one log may compare by text before it stops asking.
const MAX_TEXT_COMPARISONS = 4_000_000;

/** A CI log often holds a lint run, a typecheck and a test run one after another.
 *  Only one extractor can own the output, so name the others rather than dropping
 *  their failures without a word. */
/** A CI job usually runs a linter, then a typechecker, then the tests, and pastes all
 *  of it into one log. Only one extractor can own that output, but the failures the
 *  others found are just as real - and until now they were extracted, counted, and
 *  thrown away, so reading them meant going back to the raw log.
 *
 *  `failures` still means "what the winning tool reported", unchanged, so nothing that
 *  reads it sees a different shape. Everything else arrives here, attributed. */
function otherTools(s, winner, mine, cluster, extractors) {
  const exact = (f) => JSON.stringify([f.file ?? null, f.line ?? null, f.col ?? null, f.title ?? "", f.message ?? ""]);
  const claimed = new Map();
  const claim = (f) => claimed.set(exact(f), [...(claimed.get(exact(f)) ?? []), f]);
  const isClaimed = (f) => (claimed.get(exact(f)) ?? []).some((g) => !quoteDiffers(f, g));
  mine.forEach(claim);
  const locations = new Map();
  const remember = (f) => {
    if (!f.file) return;
    const key = JSON.stringify([fileName(f.file), f.line ?? null]);
    const at = locations.get(key) ?? [];
    at.push(f);
    locations.set(key, at);
  };
  mine.forEach(remember);
  // Two readings are one diagnosis when their text agrees and their ranges overlap. Asking
  // that of every pair was the work of a log with two tools in it: flake8 and mypy over
  // 1.6 MiB compared 41 million pairs, and doubling the log quadrupled the time. Text that
  // is equal is found by looking it up. Text that merely contains the other has to be
  // searched for, and that search stops at a budget: past it, a reading is kept rather
  // than suppressed as a copy of something it was never compared with.
  const text = new Map();
  const textOf = (f) => {
    let t = text.get(f);
    if (t === undefined) text.set(f, t = String(f.message ?? "").trim());
    return t;
  };
  const byText = new Map(), searchable = [];
  let comparisons = 0;
  const hold = (g) => {
    const t = textOf(g);
    if (!t) return;
    if (!byText.has(t)) byText.set(t, []);
    byText.get(t).push(g);
    if (t.length >= 4) searchable.push(g);
  };
  mine.forEach(hold);
  const within = (count) => {
    if (comparisons + count > MAX_TEXT_COMPARISONS) return false;
    comparisons += count;
    return true;
  };
  const sameSourceAsClaimed = (f) => {
    const x = textOf(f);
    if (!x) return false;
    // Different parsers may describe one raw line with different public fields, so the
    // private source range is the tie-breaker: only readings grounded in the same raw
    // region, and carrying the same message, may suppress one another. Text goes first
    // because it is the cheaper question. A reading that carries no range overlaps
    // nothing, so once that is known there is nothing left to compare it with.
    let located;
    const overlaps = (g) => !quoteDiffers(f, g) && (located ??= !!sourceRange(f)) && rangesOverlap(f, g);
    // The same message can be every finding in a large run - "Unexpected any" a thousand
    // times - so even the ones found by looking up are counted against the budget.
    const same = byText.get(x) ?? [];
    if (same.length && within(same.length) && same.some(overlaps)) return true;
    if (located === false || x.length < 4 || !within(searchable.length)) return false;
    return searchable.some((g) => {
      const y = textOf(g);
      return y !== x && (x.includes(y) || y.includes(x)) && overlaps(g);
    });
  };
  const others = [];
  for (const ex of extractors) {
    if (ex === winner || ex.name === "generic") continue;
    let r = null;
    try { if (ex.detect(s)) r = ex.extract(s); } catch { r = null; }
    if (!r?.failures?.length) continue;
    // A shared location does not prove a shared diagnostic, and missing locations
    // say nothing at all. Compare diagnostic content consistently for the winner and other tools.
    const fresh = dedupeFailures(r.failures.map(located)
      .filter((f) => !isClaimed(f))
      .filter((f) => !sameSourceAsClaimed(f))
      .filter((f) => !f.file || !(locations.get(JSON.stringify([fileName(f.file), f.line ?? null])) ?? [])
        .some((g) => sameLocatedDiagnostic(f, g)))
      // A tool's CLI wrapper reports that the tool exited non-zero, and that stack sits
      // entirely in node internals. It is the same failure a second time, told worse.
      .filter((f) => !isNoise(f.file))
      // A failure whose every stack frame was noise has no place in your code to point
      // at - it happened entirely inside a runtime or a tool's own internals. From a
      // tool that does not own the log that is a wrapper reporting the exit, not a
      // finding. The winner keeps its own, because sometimes that really is all there is.
      .filter((f) => !(f.hiddenFrames > 0 && f.trace?.length === 0 &&
        !f.file && !/\[ERR_[A-Z_]+\]/.test(f.code ?? "")))
      // A diagnostic with no location and no code, from a tool that does NOT own this
      // log, is a stray match on somebody else's text far more often than a finding.
      // bun prints `error: expect(received).toEqual(expected)` and cargo's `^error:`
      // claims it, which is why bun.js asks to be registered ahead of cargo - ordering
      // settles who WINS, but every other parser is still asked, so the same collision
      // arrives here instead. The winner is never filtered this way: when cargo owns a
      // log, an unanchored `error: linking with cc failed` is exactly the answer.
      .filter((f) => f.file || f.code || f.subject || f.label));
    if (!fresh.length) continue;
    for (const f of fresh) { claim(f); hold(f); remember(f); }
    others.push({
      tool: r.tool,
      count: fresh.length,
      summary: fresh.length === r.failures.length ? r.summary : undefined,
      // Grouping is per tool: a signature only means something within one vocabulary.
      clusters: cluster ? clusterFailures(fresh) : null,
      failures: fresh.map((f) => preserveSourceRange(f, { tool: r.tool, category: ex.category, ...f })),
    });
  }
  return dropEchoes(mine, others);
}

/** Drop a second tool's reading of a failure another tool already reported better.
 *
 *  A Python traceback ends `KeyError: 'taxrate'`, and node's parser recognises that as
 *  an exception - so the same failure arrives twice, once from python with a file and a
 *  line, and once from node with neither. The location test above cannot see it: the
 *  echo has no location to compare.
 *
 *  What gives it away is that the echo says strictly less. Its message is contained in
 *  the other's, and it knows less about where the failure is. A tool that genuinely
 *  found something of its own is not a substring of somebody else's finding. */
function dropEchoes(mine, others) {
  const anchored = [...mine, ...others.flatMap((o) => o.failures)].filter((f) => f.file);
  if (!anchored.length) return others;
  const echoes = (f) => !f.file && anchored.some((g) => {
    const a = String(f.message ?? "").trim();
    const b = String(g.message ?? "").trim();
    return a.length > 0 && a.length < b.length && b.includes(a);
  });
  const kept = [];
  for (const other of others) {
    const failures = other.failures.filter((f) => !echoes(f));
    if (!failures.length) continue;
    if (failures.length === other.failures.length) { kept.push(other); continue; }
    // Filtering shifts indices and may remove just one member of a group. Rebuild
    // the partition against the retained array; the old tool tally is also stale.
    kept.push({ ...other, count: failures.length, failures, summary: undefined,
      clusters: other.clusters ? clusterFailures(failures) : null });
  }
  return kept;
}

/** When whatbroke launches a leaf tool itself, its name is useful evidence for breaking
 *  ties: `whatbroke pytest tests/` says which parser should lead. A script launcher is
 *  different. `npm test`, `pnpm test`, and `yarn build` name the parent process while
 *  Jest, Vitest, Vite, or another child prints the actionable failure. Promoting the
 *  launcher would bury that cause beneath a generic non-zero-exit message.
 *
 *  Reordering still only affects parsers that both claim and extract from the log.
 *  Piped logs carry no command and are entirely unaffected. */
function ordered(command, extractors) {
  if (!command?.length) return extractors;
  // `npx jest`, `poetry run pytest`, `./node_modules/.bin/eslint` - the tool's name is
  // somewhere in the argv, not necessarily first, and not necessarily bare.
  const words = command.flatMap((a) => String(a).split(/[\\/]/))
    .map((word) => word.replace(/\.(exe|cmd|bat)$/i, "").toLowerCase());
  const hints = (extractor) => extractor.commandHints ?? extractor.commands;
  const firstMention = (extractor) => Math.min(...hints(extractor)
    .map((commandName) => words.indexOf(commandName.toLowerCase())).filter((index) => index >= 0));
  const hinted = extractors.filter((extractor) => Number.isFinite(firstMention(extractor)))
    .sort((a, b) => firstMention(a) - firstMention(b));
  return hinted.length ? [...hinted, ...extractors.filter((ex) => !hinted.includes(ex))] : extractors;
}

/** The extractor loop: first parser that claims the text AND finds something owns it. */
function parse(s, command, extractors) {
  for (const ex of ordered(command, extractors)) {
    let r = null;
    try { if (ex.detect(s)) r = ex.extract(s); } catch { r = null; }
    if (r?.failures?.length) return { extractor: ex, result: r };
  }
  return null;
}

// A parse only counts if a real parser produced it. The generic fallback scores nothing
// on purpose: "some lines that look like errors" must never outrank a parser reading its
// own tool, however many lines it managed to scrape.
const real = (hit) => !!hit && hit.extractor.name !== "generic" && hit.result.failures.length > 0;
const anything = (hit) => !!hit && hit.result.failures.length > 0;

/** Is the stripped parse better than the one we already have?
 *
 *  Not "more failures" - a prefix left in place makes parsers match fragments, and a
 *  corrupted parse frequently reports MORE failures than the clean one, not fewer.
 *
 *  A shape is hand-written and proven against the whole corpus, so a shape that covers
 *  four lines in five is a wrapper and its parse wins outright. A literal prefix is
 *  discovered automatically and is just as often data - mypy prints the same source
 *  directory at the head of every line - so it has to show a STRUCTURAL improvement:
 *  either nothing parsed before, or a different tool owns the log once it is gone.
 *  A strip that leaves the same tool reporting the same failures changed nothing except
 *  the paths inside them, which is data being mangled rather than a wrapper removed. */
function better(candidate, cand, current) {
  if (!anything(cand)) return false;
  // A vetted shape is its own evidence: hand-written, and proven against the whole
  // corpus to match nothing that is not a wrapper. It wins outright when it lets a real
  // parser read the log, and it is still worth taking when neither reading is real - a
  // guess made on prefixed text is strictly worse than the same guess made on clean
  // text, and the prefix otherwise sits inside the message where it defeats the
  // fallback's own de-duplication.
  if (candidate.kind === "shape") return real(cand) || !real(current);
  // Everything below is an automatically discovered candidate, held to a higher bar
  // because it is as likely to be data as a wrapper.
  //
  // The one exception is a log nothing could read at all. A guess made on prefixed text
  // is strictly worse than the same guess made on clean text - the fallback's patterns
  // anchor on ^, so `api:test: awk: syntax error at source line 1` matches none of them
  // and a wrapped awk failure came back silent. Requiring the unstripped text to have
  // produced NOTHING keeps the bar where it was for everything else: mypy's repeated
  // source directory still parses as mypy before the strip, so it is still rejected.
  if (!real(cand)) return !anything(current);
  // A region candidate keeps only part of the log, so it must never displace a reading
  // of the whole. It is for the case where the whole says nothing worth having.
  if (candidate.kind === "region") return !real(current);
  if (!real(current)) return true;
  if (cand.result.tool !== current.result.tool) {
    // A different tool owning the log is usually the clearest evidence a wrapper came
    // off. It is not evidence when the strip DESTROYED the reading that was there: npm
    // leads every line of its own output with "npm ", and in a log where npm was not the
    // only tool, taking that off left npm's parser matching nothing and handed the log
    // to whoever was next. The prefix a tool writes about itself is not a wrapper.
    let survives = true;
    try { survives = !!current.extractor.extract(candidate.text)?.failures?.length; }
    catch { survives = false; }
    return survives;
  }
  // Same tool, but more of the log readable once the prefix is gone. A parser can match
  // through a wrapper and swallow it: tsc reads `api:test: tsconfig.json(1,34): error`
  // as a file literally named "api:test: tsconfig.json", and misses the line that has
  // no location at all. mypy's repeated source directory, by contrast, leaves the count
  // exactly where it was - which is what says it was data rather than a wrapper.
  if (cand.result.failures.length > current.result.failures.length) return true;
  // The mirror of that, and the reason it is not enough on its own: a parser can also
  // match through a wrapper and report MORE than it should, because the prefix defeats
  // the de-duplication that would have joined two lines into one diagnosis. Perl's
  // location is prose at the end of the message rather than an anchor at the start, so
  // a one-line runner prefix left it parsing and split "Can't locate ... at f line 2"
  // from "BEGIN failed--compilation aborted at f line 2" into two failures.
  //
  // What says the prefix is a wrapper rather than data is that it is sitting INSIDE the
  // text the parser reported. mypy's repeated source directory - the case this gate
  // exists for - is in the `file` of its failures, which is the parser reading a path
  // correctly; it never leads a message.
  const swallowed = current.result.failures.some((f) =>
    String(f.message ?? "").startsWith(candidate.wrapper) || String(f.stmt ?? "").startsWith(candidate.wrapper));
  return swallowed && cand.result.failures.length < current.result.failures.length;
}

const MAX_WRAPPER_LAYERS = 3;   // CI stamps a monorepo runner that stamps a container

/** Lines of a text taken from a text taken from a log, as lines of the log. `outer` says
 *  which line of the log each line of the middle text is, `inner` which line of the middle
 *  text each line of the last one is; either is null where every line was kept. */
const through = (outer, inner) => (inner ? (outer ? inner.map((k) => outer[k]) : inner) : outer);

/** Peel wrapper prefixes for as long as peeling demonstrably improves the parse. */
function unwrap(s, command, extractors) {
  let text = s;
  let hit = parse(text, command, extractors);
  const wrappers = [];
  // Which line of `s` each line of `text` is, once a candidate has kept only some of them.
  let origin = null;
  // At most one literal strip. Once a wrapper is off, the tool's OWN uniform prefix is
  // the next thing a literal search finds - Maven leads every line with `[INFO] ` - and
  // taking that too swaps a correct parse for a different, worse one. Genuine stacking
  // is already handled: a shared prefix spanning two wrappers is found in a single pass.
  let literalsTaken = 0;
  for (let layer = 0; layer < MAX_WRAPPER_LAYERS; layer++) {
    let found = null;
    for (const c of wrapperCandidates(text)) {
      if (c.kind === "literal" && literalsTaken) continue;
      const candidate = parse(c.text, command, extractors);
      if (better(c, candidate, hit)) { found = { ...c, hit: candidate }; break; }
      // Wrappers stack: a monorepo runner relaying a container relaying a test run.
      // Peeling only the outer one is often no improvement by itself, and a strictly
      // greedy search rejects it there and never reaches the layer that pays off. Look
      // one step further before giving up on a candidate.
      if (real(candidate)) continue;
      for (const inner of wrapperCandidates(c.text)) {
        if (inner.kind === "literal" && (literalsTaken || c.kind === "literal")) continue;
        const deeper = parse(inner.text, command, extractors);
        if (better(inner, deeper, hit)) {
          found = { ...c, text: inner.text, wrapper: c.wrapper, hit: deeper, then: inner.wrapper, origin: through(c.origin, inner.origin) };
          break;
        }
      }
      if (found) break;
    }
    if (!found) break;
    if (found.kind === "literal") literalsTaken++;
    text = found.text;
    hit = found.hit;
    origin = through(origin, found.origin);
    wrappers.push(found.wrapper);
    if (found.then) wrappers.push(found.then);
  }
  return { text, hit, wrappers, origin };
}

/** How the lines a parser was given are lines of the log as it arrived, whose lines end at
 *  `\n`. Returns `lines(start, end)`: lines [start, end) of the parsed text as the runs of
 *  the log's lines they are, each `{ start, end }` inclusive, counting from 0.
 *
 *  Nearly everything done to a log before a parser reads it leaves each line where it was:
 *  colour, a CI stamp or a runner's prefix comes off the front of a line, and a retry
 *  collapsed into one copy is the first copy. Two things do not. A bare carriage return - a
 *  progress bar redrawing itself - breaks a line in two for a parser and not in the log.
 *  And BuildKit's failing steps, lifted out when nothing else in a log could be read, keep
 *  some lines and not the ones between them; `origin` says which. */
function linesOfLog(unbroken, origin) {
  let onLine = null;
  if (/\r(?!\n)/.test(unbroken)) {
    onLine = [0];
    let line = 0;
    for (const m of unbroken.matchAll(/\r\n|\r|\n/g)) {
      if (m[0] !== "\r") line++;
      onLine.push(line);
    }
  }
  const inLog = (k) => (onLine ? onLine[k] : k);
  return (start, end) => {
    const runs = [];
    const add = (from, to) => {
      const a = inLog(from), b = inLog(to), last = runs.at(-1);
      if (last && a <= last.end + 1) last.end = Math.max(last.end, b);
      else runs.push({ start: a, end: b });
    };
    if (!origin) {
      if (end > start) add(start, end - 1);
      return runs;
    }
    let from = null, to = null;
    for (let k = start; k < end; k++) {
      const at = origin[k];
      if (at === undefined) continue;
      if (from !== null && at === to + 1) { to = at; continue; }
      if (from !== null) add(from, to);
      from = to = at;
    }
    if (from !== null) add(from, to);
    return runs;
  };
}

/** CI systems commonly append a byte-identical failed retry to the first attempt.
 * Parsers then see every tally twice, while the reader's public de-duplication keeps
 * each diagnostic once. Collapse only an exact whole-stream repetition: unlike trying
 * to reinterpret thirty parser-specific headlines, this also keeps hidden counts,
 * passing counts, secondary tools and wrapper provenance consistent with what is shown.
 *
 * The midpoint check is constant-work for ordinary logs. Four identical attempts
 * collapse recursively; non-identical retries remain separate and are not guessed at. */
function collapseExactRetries(text) {
  let current = text;
  while (true) {
    let end = current.length;
    while (end > 0 && current[end - 1] === "\n") end--;
    const body = current.slice(0, end);
    let collapsed = null;
    for (const separator of ["\n\n", "\n"]) {
      const contentLength = body.length - separator.length;
      if (contentLength <= 0 || contentLength % 2) continue;
      const middle = contentLength / 2;
      if (body.slice(middle, middle + separator.length) !== separator) continue;
      if (body.slice(0, middle) === body.slice(middle + separator.length)) {
        collapsed = body.slice(0, middle) + (end < current.length ? "\n" : "");
        break;
      }
    }
    if (collapsed === null) return current;
    current = collapsed;
  }
}

function analyseWhole(raw, { cluster = true, command = null, route = true } = {}) {
  // Windows tools, and logs pasted out of Windows CI, arrive with CRLF. Every
  // parser anchors on $, so a stray \r makes all of them silently match nothing.
  // A byte-order mark is not content. PowerShell writes one at the head of anything it
  // redirects, so a log captured on Windows and piped in later begins with U+FEFF - and
  // every parser anchors on ^, so the first line stops matching. 25 of the fixtures read
  // differently with one in front of them; bun's unresolved import fell to the guess.
  const unbroken = stripRedrawnCiPrefix(stripCiPrefix(stripAnsi(raw.replace(/^\uFEFF/, ""))));
  const base = collapseExactRetries(unbroken.replace(/\r\n?/g, "\n"));
  // The parsers that could read anything from this log, asked once for the log and every
  // wrapper stripped from it - see src/router.js.
  const extractors = route ? readers(base, EXTRACTORS) : EXTRACTORS;
  const { text: s, hit, wrappers, origin } = unwrap(base, command, extractors);
  if (!hit) return null;
  const r = hit.result;
  // dedupe first: it collapses the SAME diagnostic printed twice, so cluster
  // sizes end up counting real distinct sites rather than print repetitions.
  const failures = dedupeFailures(r.failures.map(located))
    .map((f) => preserveSourceRange(f, { tool: r.tool, category: hit.extractor.category, ...f }));
  const clusters = cluster ? clusterFailures(failures) : null;
  const others = otherTools(s, hit.extractor, failures, cluster, extractors);
  const answer = {
    ...r, failures, clusters,
    ...(others.length ? { others } : {}),
    // Which package or build step the output came from is worth keeping, not discarding.
    ...(wrappers.length ? { wrappers } : {}),
  };
  return setLines(setParser(answer, hit.extractor), linesOfLog(unbroken, origin));
}

/** `route: false` asks every parser about the log, as the router's own tests need to. */
export function analyse(raw, { cluster = true, command = null, route = true } = {}) {
  return analyseWhole(raw, { cluster, command, route });
}
