import pytest from "./extractors/pytest.js";
import { traceback, unittest } from "./extractors/python.js";
import node from "./extractors/node.js";
import nodetest from "./extractors/nodetest.js";
import bun from "./extractors/bun.js";
import deno from "./extractors/deno.js";
import tsc from "./extractors/tsc.js";
import jest from "./extractors/jest.js";
import playwright from "./extractors/playwright.js";
import vitest from "./extractors/vitest.js";
import eslint from "./extractors/eslint.js";
import ruff from "./extractors/ruff.js";
import mypy from "./extractors/mypy.js";
import pyright from "./extractors/pyright.js";
import clang from "./extractors/clang.js";
import cmake from "./extractors/cmake.js";
import rspec from "./extractors/rspec.js";
import jvm from "./extractors/jvm.js";
import dotnet from "./extractors/dotnet.js";
import dotnettest from "./extractors/dotnettest.js";
import phpunit from "./extractors/phpunit.js";
import gotest from "./extractors/gotest.js";
import cargo from "./extractors/cargo.js";
import { esbuild, vite } from "./extractors/bundler.js";
import git from "./extractors/git.js";
import kubectl from "./extractors/kubectl.js";
import npm from "./extractors/npm.js";
import { pnpm, yarn } from "./extractors/pkgmanager.js";
import pip from "./extractors/pip.js";
import generic from "./extractors/generic.js";
import { stripAnsi, stripCiPrefix, isNoise } from "./util.js";
import { clusterFailures } from "./cluster.js";
import { wrapperCandidates } from "./normalize.js";

// order matters: most specific first, generic last
export const EXTRACTORS = [pytest, nodetest, bun, deno, playwright, jest, vitest, unittest, traceback, eslint, ruff, pyright, mypy, cmake, clang, rspec, jvm, dotnettest, dotnet, phpunit, cargo, gotest, esbuild, vite, node, tsc, git, kubectl, npm, pnpm, yarn, pip, generic];

function dedupeFailures(failures) {
  const seen = new Set();
  return failures.filter((failure) => {
    const key = JSON.stringify([
      failure.file ?? null, failure.line ?? null, failure.col ?? null,
      failure.title ?? "", failure.message ?? "", failure.stmt ?? "",
    ]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

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
function otherTools(s, winner, mine, cluster) {
  const at = (f) => `${f.file ?? ""}:${f.line ?? ""}`;
  const exact = (f) => JSON.stringify([f.file ?? null, f.line ?? null, f.col ?? null, f.title ?? "", f.message ?? ""]);
  const seen = new Set(mine.map(at));
  const claimed = new Set();
  const others = [];
  for (const ex of EXTRACTORS) {
    if (ex === winner || ex.name === "generic") continue;
    let r = null;
    try { if (ex.detect(s)) r = ex.extract(s); } catch { r = null; }
    if (!r?.failures?.length) continue;
    // Some tools report the same failure a second way - unittest prints its
    // failures AS Python tracebacks. If every location is one the winner already
    // covers, this is the same output read twice, not another tool that failed.
    const fresh = dedupeFailures(r.failures
      .filter((f) => !seen.has(at(f)))
      .filter((f) => !claimed.has(exact(f)))
      // A tool's CLI wrapper reports that the tool exited non-zero, and that stack sits
      // entirely in node internals. It is the same failure a second time, told worse.
      .filter((f) => !isNoise(f.file))
      // A failure whose every stack frame was noise has no place in your code to point
      // at - it happened entirely inside a runtime or a tool's own internals. From a
      // tool that does not own the log that is a wrapper reporting the exit, not a
      // finding. The winner keeps its own, because sometimes that really is all there is.
      .filter((f) => !(f.hiddenFrames > 0 && f.trace?.length === 0))
      // A diagnostic with no location and no code, from a tool that does NOT own this
      // log, is a stray match on somebody else's text far more often than a finding.
      // bun prints `error: expect(received).toEqual(expected)` and cargo's `^error:`
      // claims it, which is why bun.js asks to be registered ahead of cargo - ordering
      // settles who WINS, but every other parser is still asked, so the same collision
      // arrives here instead. The winner is never filtered this way: when cargo owns a
      // log, an unanchored `error: linking with cc failed` is exactly the answer.
      .filter((f) => f.file || f.code || f.subject || f.label));
    if (!fresh.length) continue;
    // Between two OTHER tools the location alone is too blunt: eslint and tsc can flag
    // the same line for entirely different reasons, and dropping one of those loses a
    // real diagnosis. Only an identical diagnostic is a repeat. The winner keeps the
    // looser location test above, which is what stops unittest's failures arriving a
    // second time as Python tracebacks.
    for (const f of fresh) claimed.add(exact(f));
    others.push({
      tool: r.tool,
      count: fresh.length,
      summary: r.summary,
      // Grouping is per tool: a signature only means something within one vocabulary.
      clusters: cluster ? clusterFailures(fresh) : null,
      failures: fresh.map((f) => ({ tool: r.tool, category: ex.category, ...f })),
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
    kept.push({ ...other, count: failures.length, failures,
      clusters: other.clusters ? other.clusters.filter((c) => c.members.every((i) => !echoes(other.failures[i]))) : null });
  }
  return kept;
}

/** When whatbroke launches the command itself it knows what was run, and that is
 *  evidence no log line can contradict: someone typing `whatbroke pytest tests/` is
 *  telling us which tool is about to fail. It only reorders - the parser still has to
 *  claim the text and find something - so a log that turns out to be from another tool
 *  is read correctly anyway. Piped logs carry no command and are entirely unaffected. */
function ordered(command) {
  if (!command?.length) return EXTRACTORS;
  // `npx jest`, `poetry run pytest`, `./node_modules/.bin/eslint` - the tool's name is
  // somewhere in the argv, not necessarily first, and not necessarily bare.
  const words = new Set(command.flatMap((a) => String(a).split(/[\\/]/)).map((w) => w.replace(/\.(exe|cmd|bat)$/i, "")));
  const hinted = EXTRACTORS.filter((ex) => ex.commands?.some((c) => words.has(c)));
  return hinted.length ? [...hinted, ...EXTRACTORS.filter((ex) => !hinted.includes(ex))] : EXTRACTORS;
}

/** The extractor loop: first parser that claims the text AND finds something owns it. */
function parse(s, command) {
  for (const ex of ordered(command)) {
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
  if (!real(cand)) return false;
  // A region candidate keeps only part of the log, so it must never displace a reading
  // of the whole. It is for the case where the whole says nothing worth having.
  if (candidate.kind === "region") return !real(current);
  if (!real(current)) return true;
  if (cand.result.tool !== current.result.tool) return true;
  // Same tool, but more of the log readable once the prefix is gone. A parser can match
  // through a wrapper and swallow it: tsc reads `api:test: tsconfig.json(1,34): error`
  // as a file literally named "api:test: tsconfig.json", and misses the line that has
  // no location at all. mypy's repeated source directory, by contrast, leaves the count
  // exactly where it was - which is what says it was data rather than a wrapper.
  return cand.result.failures.length > current.result.failures.length;
}

const MAX_WRAPPER_LAYERS = 3;   // CI stamps a monorepo runner that stamps a container

/** Peel wrapper prefixes for as long as peeling demonstrably improves the parse. */
function unwrap(s, command) {
  let text = s;
  let hit = parse(text, command);
  const wrappers = [];
  // At most one literal strip. Once a wrapper is off, the tool's OWN uniform prefix is
  // the next thing a literal search finds - Maven leads every line with `[INFO] ` - and
  // taking that too swaps a correct parse for a different, worse one. Genuine stacking
  // is already handled: a shared prefix spanning two wrappers is found in a single pass.
  let literalsTaken = 0;
  for (let layer = 0; layer < MAX_WRAPPER_LAYERS; layer++) {
    let found = null;
    for (const c of wrapperCandidates(text)) {
      if (c.kind === "literal" && literalsTaken) continue;
      const candidate = parse(c.text, command);
      if (better(c, candidate, hit)) { found = { ...c, hit: candidate }; break; }
      // Wrappers stack: a monorepo runner relaying a container relaying a test run.
      // Peeling only the outer one is often no improvement by itself, and a strictly
      // greedy search rejects it there and never reaches the layer that pays off. Look
      // one step further before giving up on a candidate.
      if (real(candidate)) continue;
      for (const inner of wrapperCandidates(c.text)) {
        if (inner.kind === "literal" && (literalsTaken || c.kind === "literal")) continue;
        const deeper = parse(inner.text, command);
        if (better(inner, deeper, hit)) { found = { ...c, text: inner.text, wrapper: c.wrapper, hit: deeper, then: inner.wrapper }; break; }
      }
      if (found) break;
    }
    if (!found) break;
    if (found.kind === "literal") literalsTaken++;
    text = found.text;
    hit = found.hit;
    wrappers.push(found.wrapper);
    if (found.then) wrappers.push(found.then);
  }
  return { text, hit, wrappers };
}

export function analyse(raw, { cluster = true, command = null } = {}) {
  // Windows tools, and logs pasted out of Windows CI, arrive with CRLF. Every
  // parser anchors on $, so a stray \r makes all of them silently match nothing.
  const base = stripCiPrefix(stripAnsi(raw).replace(/\r\n?/g, "\n"));
  const { text: s, hit, wrappers } = unwrap(base, command);
  if (!hit) return null;
  const r = hit.result;
  // dedupe first: it collapses the SAME diagnostic printed twice, so cluster
  // sizes end up counting real distinct sites rather than print repetitions.
  const failures = dedupeFailures(r.failures).map((f) => ({ tool: r.tool, category: hit.extractor.category, ...f }));
  const clusters = cluster ? clusterFailures(failures) : null;
  const others = otherTools(s, hit.extractor, failures, cluster);
  return {
    ...r, failures, clusters,
    ...(others.length ? { others } : {}),
    // Which package or build step the output came from is worth keeping, not discarding.
    ...(wrappers.length ? { wrappers } : {}),
  };
}
