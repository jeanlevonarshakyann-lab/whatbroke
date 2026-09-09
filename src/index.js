import pytest from "./extractors/pytest.js";
import { traceback, unittest } from "./extractors/python.js";
import node from "./extractors/node.js";
import nodetest from "./extractors/nodetest.js";
import bun from "./extractors/bun.js";
import deno from "./extractors/deno.js";
import tsc from "./extractors/tsc.js";
import jest from "./extractors/jest.js";
import vitest from "./extractors/vitest.js";
import eslint from "./extractors/eslint.js";
import ruff from "./extractors/ruff.js";
import mypy from "./extractors/mypy.js";
import clang from "./extractors/clang.js";
import rspec from "./extractors/rspec.js";
import jvm from "./extractors/jvm.js";
import dotnet from "./extractors/dotnet.js";
import dotnettest from "./extractors/dotnettest.js";
import phpunit from "./extractors/phpunit.js";
import gotest from "./extractors/gotest.js";
import cargo from "./extractors/cargo.js";
import npm from "./extractors/npm.js";
import generic from "./extractors/generic.js";
import { stripAnsi, stripCiPrefix } from "./util.js";
import { clusterFailures } from "./cluster.js";
import { wrapperCandidates } from "./normalize.js";

// order matters: most specific first, generic last
export const EXTRACTORS = [pytest, nodetest, bun, deno, jest, vitest, unittest, traceback, eslint, ruff, mypy, clang, rspec, jvm, dotnettest, dotnet, phpunit, cargo, gotest, node, tsc, npm, generic];

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
      .filter((f) => !claimed.has(exact(f))));
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
  return others;
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
  if (!real(cand)) return false;
  if (candidate.kind === "shape") return true;
  if (!real(current)) return true;
  return cand.result.tool !== current.result.tool;
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
    }
    if (!found) break;
    if (found.kind === "literal") literalsTaken++;
    text = found.text;
    hit = found.hit;
    wrappers.push(found.wrapper);
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
