// Wrapper prefixes.
//
// Turborepo prints `api:test: ` in front of every line. Docker BuildKit prints
// `#12 1.234 `. pnpm prints the package and script. kubectl prints the pod. Every
// parser here anchors on the start of a line, so any one of these turns a perfectly
// readable pytest run into nothing at all - not a degraded result, zero.
//
// Stripping a prefix is dangerous in the other direction: `npm error ` also leads
// every line of an npm failure, and removing it would destroy the very thing npm's
// parser detects on. So nothing here decides on its own whether a prefix is a wrapper.
// This module only proposes candidates; src/index.js keeps one only when parsing the
// stripped text finds MORE than parsing the original did. A strip that does not help
// is discarded, which is what makes it impossible for this to lose information.

const SAMPLE_LINES = 200;
const UNIFORM = 0.8;      // the share of lines a prefix must cover, as in stripCiPrefix
const MIN_PREFIX = 2;
const MAX_PREFIX = 200;
const MAX_LITERAL_CANDIDATES = 4;   // bound the parses a single log can cost

const sample = (text) => text.split("\n").filter((l) => l.trim()).slice(0, SAMPLE_LINES);

/** The longest literal string that begins at least UNIFORM of the sampled lines.
 *
 *  This is the primary mechanism because it distinguishes a wrapper from a coincidence
 *  for free: Turborepo's `api:test: ` is the same on every line, while mypy's
 *  `src/pkg/mod.py:12:` merely looks similar and shares almost nothing. Seeded from
 *  several lines because the first one is sometimes a banner that carries no prefix. */
function literalPrefix(text) {
  const lines = sample(text);
  if (lines.length < 3) return "";
  const need = Math.ceil(lines.length * UNIFORM);
  let best = "";
  for (const seed of lines.slice(0, 3)) {
    let p = seed.slice(0, MAX_PREFIX);
    while (p.length > MIN_PREFIX) {
      if (lines.filter((l) => l.startsWith(p)).length >= need) break;
      p = p.slice(0, -1);
    }
    // Do not swallow the log's own indentation. eslint puts its problems under the
    // file they belong to, so the shared prefix runs on into that indentation - and
    // removing it takes away the very thing eslint's parser matches on.
    p = p.replace(/[ \t]+$/, " ");
    if (p.length > MIN_PREFIX && p.trim() && p.length > best.length) best = p;
  }
  return best;
}

// Prefixes whose tail changes on every line, so no literal string is shared. Kept to a
// minimum: each one is a standing risk of matching something that is not a wrapper, and
// every shape added here has to be proven against the whole fixture corpus.
// The CI timestamp is not here - stripCiPrefix in util.js already handles it.
const SHAPES = [
  // Docker BuildKit: "#12 1.234 " - step number constant, elapsed seconds counting up.
  { name: "docker", re: /^#\d+\s+\d+\.\d+\s/ },
];

const uniform = (text, re) => {
  const lines = sample(text);
  return lines.length >= 3 && lines.filter((l) => re.test(l)).length >= Math.ceil(lines.length * UNIFORM);
};

const stripLiteral = (text, p) =>
  text.split("\n").map((l) => (l.startsWith(p) ? l.slice(p.length) : l)).join("\n");

const stripShape = (text, re) => text.split("\n").map((l) => l.replace(re, "")).join("\n");

/** Every normalisation worth trying on this text. Proposals only - the caller decides.
 *
 *  Shapes come first and carry more authority than a literal prefix. Each one is
 *  hand-written and proven against the whole fixture corpus, so a shape that matches
 *  four lines in five is a wrapper. A literal prefix is found automatically and can
 *  just as easily be data - mypy prints the same source directory on every line - so
 *  the caller holds it to a stricter test. */
export function wrapperCandidates(text) {
  const out = [];
  for (const shape of SHAPES) {
    if (uniform(text, shape.re)) out.push({ kind: "shape", wrapper: shape.name, text: stripShape(text, shape.re) });
  }
  for (const literal of literalCandidates(literalPrefix(text))) {
    out.push({ kind: "literal", wrapper: literal, text: stripLiteral(text, literal) });
  }
  return out.filter((c) => c.text !== text);
}

/** The longest shared prefix is not always the wrapper.
 *
 *  npm begins every line with `npm error ` and Maven with `[ERROR] `, so a wrapped npm
 *  log shares `api:test: npm error ` on every line and cutting all of it away takes the
 *  tool's own marker with it. Offer the truncations at each whitespace boundary as well,
 *  shortest first, so the least destructive strip that actually works is the one taken. */
function literalCandidates(prefix) {
  if (!prefix) return [];
  const stops = [];
  for (const m of prefix.matchAll(/\S[ \t]+/g)) {
    const end = m.index + m[0].length;
    if (end > MIN_PREFIX && end < prefix.length) stops.push(prefix.slice(0, end));
  }
  return [...stops, prefix].slice(0, MAX_LITERAL_CANDIDATES);
}
