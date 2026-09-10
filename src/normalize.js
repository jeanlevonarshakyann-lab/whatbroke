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
// A hand-written shape may be held to a lower share than a discovered literal. Docker
// BuildKit stamps the step's own output and nothing else - not the `------` rules, the
// Dockerfile excerpt, or the final "failed to solve" line - so its prefix covers about
// seven lines in ten of a failing build and would never clear the gate above. The shape
// is proven against the whole corpus, and the improvement rule is still the backstop:
// a strip that does not let a real parser find more is discarded either way.
const SHAPE_UNIFORM = 0.4;
const MIN_PREFIX = 2;
const MAX_PREFIX = 200;
const MAX_LITERAL_CANDIDATES = 4;   // bound the parses a single log can cost
// These are tool syntax, not relay syntax. In a mixed log, stripping one can make a
// different parser win and therefore look like an improvement even though it erased a
// complete Maven or npm invocation.
const NATIVE_PREFIX = /^(?:\[ERROR\][^\S\n]+|npm (?:error|ERR!)[^\S\n]?)$/;

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
    p = p.replace(/[^\S\n]+$/, " ");
    if (p.length > MIN_PREFIX && p.trim() && p.length > best.length) best = p;
  }
  return best;
}

// Prefixes whose tail changes on every line, so no literal string is shared. Kept to a
// minimum: each one is a standing risk of matching something that is not a wrapper, and
// every shape added here has to be proven against the whole fixture corpus.
// Bare ISO CI timestamps are not here - stripCiPrefix in util.js already handles them.
const SHAPES = [
  // Docker BuildKit: "#12 1.234 " - step number constant, elapsed seconds counting up.
  //
  // Requiring the elapsed column undercounted, because BuildKit's other lines - the
  // step header, "#12 DONE 0.3s", "#12 CACHED", the export lines - do not carry one.
  // In a log holding two builds that pushed the shape below the uniformity threshold,
  // so it lost to the region fallback, which keeps only what Docker reprints after the
  // rule; pytest's FAILURES section is outside that, and the run said nothing useful.
  //
  // Making the column merely optional is too loose the other way: "#0 /path/f.php(98):"
  // is a PHP stack frame, and PHPUnit's own fixture matched it on every line. So what
  // follows "#12 " has to be something BuildKit writes, listed here rather than guessed.
  // Exactly one space goes with the elapsed column: BuildKit writes one, and eating a
  // run of them would take the wrapped tool's own indentation with it.
  { name: "docker", re: /^#\d+[^\S\n]+(?:\d+\.\d+[^\S\n]|(?=\[|DONE\b|CACHED\b|ERROR\b|CANCELED\b|WARN\b|sha256:|building\b|transferring\b|extracting\b|exporting\b|writing\b|naming\b|unpacking\b|preparing\b|resolve\b|pulling\b|load\b|done\b))/ },

  // Jenkins' Timestamper plugin brackets the time, which is why the CI-stamp rule does
  // not see it: that one wants a bare ISO instant at position zero. It writes either
  // form depending on how the job is configured. 95 of the fixtures lost their parser
  // through one of these.
  { name: "jenkins", re: /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:[.,]\d+)?Z?\][^\S\n]/ },
  { name: "jenkins", re: /^\[\d{2}:\d{2}:\d{2}\][^\S\n]/ },

  // buildkite-agent --timestamp-lines brackets a local timestamp, with a space where
  // ISO 8601 has `T`: "[2026-09-10 07:14:55] ". It therefore misses both the bare-ISO
  // CI stamp and Jenkins shapes. This exact shape matched zero lines in the corpus.
  { name: "buildkite", re: /^\[\d{4}-\d{2}-\d{2}[^\S\n]\d{2}:\d{2}:\d{2}\][^\S\n]/ },

  // A log collected by journald or syslog rather than read off the terminal:
  // "Sep 10 07:14:55 runner app[123]: ". The host and unit vary per deployment but the
  // month-day-time-host-unit shape does not.
  { name: "syslog", re: /^[A-Z][a-z]{2}[^\S\n]{1,2}\d{1,2}[^\S\n]\d{2}:\d{2}:\d{2}[^\S\n]\S+[^\S\n]\S+?(?:\[\d+\])?:[^\S\n]/ },
];

// No floor on line count. This gate is only ever asked about a SHAPE, and a shape is
// hand-written and proven against the whole corpus to match nothing that is not a
// wrapper - it needs no comparison between lines to earn its keep. The floor belongs to
// the literal search, which infers a prefix by comparing lines and where on one line any
// leading text looks uniform; that search keeps its own guard, a few lines above.
//
// Requiring three here meant a one-line log could never have a wrapper taken off it, and
// a one-line log is exactly the one whose whole diagnosis is that line: `fatal: not a
// git repository` under a Jenkins timestamp came back with nothing at all.
const uniform = (text, re, share = UNIFORM) => {
  const lines = sample(text);
  return lines.length > 0 && lines.filter((l) => re.test(l)).length >= Math.ceil(lines.length * share);
};

const stripLiteral = (text, p) =>
  text.split("\n").map((l) => (l.startsWith(p) ? l.slice(p.length) : l)).join("\n");

const stripShape = (text, re) => text.split("\n").map((l) => l.replace(re, "")).join("\n");

/** A progress renderer uses bare carriage returns inside one physical line. A CI
 * collector consequently stamps the whole blob once, rather than stamping each
 * logical line. Remove that one vetted stamp before CR normalisation expands the blob
 * and makes the prefix appear non-uniform. Literal prefixes remain too ambiguous to
 * infer from a single physical line. */
export function stripRedrawnCiPrefix(text) {
  if (!/\r(?!\n)/.test(text)) return text;
  for (const { re } of SHAPES) {
    if (re.test(text)) return text.replace(re, "");
  }
  return text;
}

// Docker BuildKit ends a failed build by quoting the failing step's own output between
// two rules, then states the mechanism:
//
//   ------
//    > [4/4] RUN npm test:
//   0.234 npm error Missing script: "test"
//   ------
//   Dockerfile:8
//   ...
//   ERROR: failed to solve: process "/bin/sh -c npm test" did not complete successfully
//
// That last line is what whatbroke reported, and it names the mechanism rather than the
// cause. The block above it is the cause, verbatim, from whatever tool actually failed.
// A coverage ratio cannot find it - a short npm failure is five lines inside a frame of
// twenty - so the block is located by its own markers instead.
const BUILDKIT_RULE = /^-{6,}[^\S\n]*$/;
const BUILDKIT_STEP = /^[^\S\n]*>[^\S\n]+\[[^\]]+\][^\S\n]+.*:[^\S\n]*$/;
const BUILDKIT_ELAPSED = /^\d+\.\d+[^\S\n]/;

/** The failing step's output, lifted out of the frame Docker wraps it in. */
function buildkitBlock(text) {
  // Docker words this differently depending on version and driver - `failed to solve`
  // alone, or `failed to build: failed to solve`. Anchor on the part that does not move.
  if (!/^ERROR: (?:[\w .]+: )?failed to solve:/m.test(text)) return null;
  const lines = text.split("\n");
  // Every failing step, not just the first. A CI job that builds two images writes two
  // of these blocks, and keeping only one meant the whole text lost to Docker's own
  // "failed to solve" line - so a two-image job reported that both builds failed and
  // nothing about why either did.
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    if (!BUILDKIT_RULE.test(lines[i]) || !BUILDKIT_STEP.test(lines[i + 1] ?? "")) continue;
    const body = [];
    for (let j = i + 2; j < lines.length && !BUILDKIT_RULE.test(lines[j]); j++) {
      // each line keeps the seconds-since-step-start column; the tool never wrote it
      body.push(lines[j].replace(BUILDKIT_ELAPSED, ""));
    }
    if (body.some((l) => l.trim())) blocks.push(body.join("\n"));
  }
  return blocks.length ? blocks.join("\n") : null;
}

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
    if (uniform(text, shape.re, SHAPE_UNIFORM)) out.push({ kind: "shape", wrapper: shape.name, text: stripShape(text, shape.re) });
  }
  const block = buildkitBlock(text);
  // A region candidate throws away everything outside the block, so it is only ever
  // taken when nothing real parsed from the whole text - see `better` in index.js.
  if (block) out.push({ kind: "region", wrapper: "docker buildkit", text: block });
  for (const literal of literalCandidates(literalPrefix(text))) {
    if (NATIVE_PREFIX.test(literal)) continue;
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
  for (const m of prefix.matchAll(/\S[^\S\n]+/g)) {
    const end = m.index + m[0].length;
    if (end > MIN_PREFIX && end < prefix.length) stops.push(prefix.slice(0, end));
  }
  return [...stops, prefix].slice(0, MAX_LITERAL_CANDIDATES);
}
