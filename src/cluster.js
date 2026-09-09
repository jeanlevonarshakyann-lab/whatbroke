// Group failures that share a likely root cause.
//
// The governing rule: over-splitting is cheap, over-merging is fatal. Splitting one
// cause into two costs the reader one extra block. Merging two causes into one makes
// them fix the exemplar, rerun, and watch the rest still fail - after which they stop
// believing the "likely cause" line anywhere. This tool never invents anything, and a
// wrong merge is an invention. Every rule below is tuned toward refusing to group.

export const MIN_CLUSTER = 3;   // two failures sharing a shape is usually coincidence

// A tool's `title` is either a diagnostic code (discriminating - keep it) or the name
// of the site (the axis we cluster across - drop it). This is a table and not a
// heuristic because no heuristic separates "no-unused-vars" from "test_invoice_total".
const TITLE_IS_CODE = new Set(["tsc", "mypy", "ruff", "clang", "dotnet", "cargo", "eslint", "node"]);
const TITLE_IS_SITE = new Set(["pytest", "unittest", "python", "jest", "vitest", "go test", "cargo test", "rspec", "phpunit", "dotnet test", "node --test", "bun test", "deno test"]);
const TITLE_IS_CONST = new Set(["go build", "gradle", "maven", "jvm", "output", "npm"]);
export const TOOL_TITLE_SETS = { TITLE_IS_CODE, TITLE_IS_SITE, TITLE_IS_CONST };

/** Unknown tools KEEP the title: a new extractor whose title is a test name then gets
 *  no clustering at all, rather than wrong clustering. Inert beats harmful. */
export const titlePolicy = (tool) => ({
  title: !TITLE_IS_SITE.has(tool),
  // For a compiler or linter the echoed source line is the INSTANCE, not the
  // identity - the code and message already say which problem it is, and the same
  // lint in forty places is one thing to fix. For a test runner the failing
  // expression is the strongest discriminator there is, so it stays.
  stmt: !TITLE_IS_CODE.has(tool),
});

// Quoted content that is short and has no whitespace is a NAME - unquote and keep it,
// so KeyError: 'exp' stays distinct from KeyError: 'sub'. Anything else is DATA.
// The lookbehind matters: without it the apostrophe in "doesn't" opens a match that
// swallows the rest of the line.
const QUOTED = /(?<![A-Za-z0-9_])'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\\n]|\\.)*`/g;
const NAME_MAX = 32;

const SRC_EXT = "js|jsx|mjs|cjs|ts|tsx|py|pyi|rs|go|java|kt|kts|rb|php|c|cc|cpp|cxx|h|hh|hpp|m|mm|cs|swift|scala|sh|sql|json|ya?ml|toml|lock";

/** Reduce a message to its shape, keeping the parts that identify WHICH bug it is.
 *  Rule order is load-bearing; each step assumes the previous ones have run. */
export function skeleton(text) {
  let s = String(text ?? "").slice(0, 1000);
  s = s.replace(/\s+/g, " ").trim();

  // 1. quoted values, before anything that could chew their insides
  s = s.replace(QUOTED, (m) => {
    const inner = m.slice(1, -1);
    return inner.length <= NAME_MAX && !/\s/.test(inner) ? inner : "<str>";
  });

  // 2. urls before paths, or the // in https:// counts as separators
  s = s.replace(/\b[a-z][\w+.-]*:\/\/\S+/gi, "<url>");

  // 3. paths must PROVE themselves - a drive prefix, two separators, or a known source
  //    extension. Otherwise "cart.total" and "result.output" get eaten.
  s = s.replace(/\b[A-Za-z]:[\\/][^\s'"]+/g, "<path>")
       .replace(/(?:[\w.@+~-]+)?(?:[/\\][\w.@+~-]+){2,}/g, "<path>")
       // take a leading separator with it, or "/route.json" normalises to "/<path>"
       // while "/foo/bar" normalises to "<path>" and the two never cluster
       .replace(new RegExp(String.raw`(?:[/\\])?\b[\w.@+-]+\.(?:${SRC_EXT})\b`, "g"), "<path>");

  // 4. machine identifiers, before numbers. The lookahead on <hex> requires a digit so
  //    it cannot eat English words spelled only with a-f ("defaced").
  s = s.replace(/\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g, "<uuid>")
       .replace(/\b0[xX][0-9a-fA-F]+\b/g, "<addr>")
       .replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{7,}\b/g, "<hex>");

  // 5. numbers. \b on both sides is what keeps TS2551, E0308, i64, utf8 intact.
  s = s.replace(/\b\d+(?:\.\d+)?\b/g, "<num>");
  s = s.replace(/<num>(?:\s*,\s*<num>)+/g, "<num>*");

  return s.replace(/\s+/g, " ").trim().slice(0, 512);
}

/** Trailing bracket group only, and only for the DISPLAY label. Applying this to
 *  messages would destroy list[int], [OPTIONS] and [-Wint-conversion]. */
export const normTitle = (t) => String(t ?? "").replace(/\[[^\]]*\]\s*$/, "[…]").trim();

const part = (f, policy) => [
  policy.title ? String(f.title ?? "") : "",
  skeleton(f.message),
  policy.stmt === false ? "" : skeleton(f.stmt),
];

export const keyOf = (f, policy) => JSON.stringify(part(f, policy));
export const signatureOf = (f, policy) => part(f, policy).filter(Boolean).join("  ·  ");

const PLACEHOLDER = /<(?:str|num|path|url|hex|uuid|addr)>\*?/g;
// Node's assertion header describes the matcher, not the bug. After numeric
// values disappear, it must not turn an otherwise empty signature into evidence.
// Keep the header in the fingerprint; discount it only when scoring information.
const ASSERTION_BOILERPLATE = /\bAssertionError(?: \[ERR_ASSERTION\])?: Expected values (?:not )?to be (?:(?:strictly|loosely) )?(?:deep-)?equal:\s*/g;

/** How much real content a signature carries. "assert <num> == <num>" scores 1 and is
 *  refused: forty unrelated numeric assertions must not become one "likely cause". */
export function contentScore(sig) {
  const words = sig.replace(ASSERTION_BOILERPLATE, " ").replace(PLACEHOLDER, " ")
    .match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  return new Set(words).size;
}

export function fingerprint(key) {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Partition failures by shared cause. Every failure appears in exactly one cluster,
 *  including singletons, so consumers never have to reconcile two lists. */
export function clusterFailures(failures, tool) {
  const policy = titlePolicy(tool);
  const buckets = new Map();
  failures.forEach((f, i) => {
    const key = keyOf(f, policy);
    const at = buckets.get(key);
    if (at) at.push(i); else buckets.set(key, [i]);
  });

  const clusters = [];
  for (const [key, members] of buckets) {
    const sig = signatureOf(failures[members[0]], policy);
    // prefer an exemplar that can actually show source
    const located = members.find((i) => failures[i].file && failures[i].line);
    const reported = members.length >= MIN_CLUSTER && contentScore(sig) >= 2;
    if (reported) {
      clusters.push({ id: fingerprint(key), signature: sig, size: members.length, members, exemplar: located ?? members[0], reported: true });
    } else {
      // refused: emit each member as its own unit so nothing is hidden behind a
      // grouping we were not confident enough to claim
      for (const i of members) {
        clusters.push({ id: fingerprint(key + ":" + i), signature: sig, size: 1, members: [i], exemplar: i, reported: false });
      }
    }
  }

  // reported first (largest first), then everything in document order. Sorting by size
  // alone would promote an unreported pair and silently reorder today's output.
  return clusters.sort((a, b) =>
    (b.reported - a.reported) || (b.reported && b.size - a.size) || (a.exemplar - b.exemplar));
}
