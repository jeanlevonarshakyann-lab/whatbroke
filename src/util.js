export const ANSI = new RegExp("\\x1b\\[[0-9;]*[a-zA-Z]", "g");
export const stripAnsi = (s) => s.replace(ANSI, "");

/** Keep the first copy of each public diagnostic. Extractors that build a numerical
 * headline use this before counting so a retried/concatenated log cannot say more
 * failures were shown than survive the reader's final de-duplication. */
export function uniqueFailures(failures) {
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

/** Node/py internals and vendored code are almost never what you're looking for. */
const NOISE = [
  /^node:/, /node:internal/, /[/\\]node_modules[/\\]/, /[/\\]site-packages[/\\]/,
  /[/\\]lib[/\\]python3\.\d+[/\\]/, /<frozen [a-z_.]+>/,
  /\.pnpm[/\\]/,
  // Ruby's stdlib and installed gems. A failing `require` is raised inside rubygems, so
  // without these the location reported for a missing gem was kernel_require.rb.
  /[/\\]gems[/\\]/, /[/\\]rubygems[/\\]/, /Ruby\.framework[/\\]/, /[/\\]lib[/\\]ruby[/\\]/,
  // node's own eval/REPL machinery — the [eval]:N frame is real, its wrapper is not
  /^\[eval\]-wrapper/, /^evalmachine/, /^\[stdin\]-wrapper/,
];
export const isNoise = (p) => !!p && NOISE.some((re) => re.test(p));

export function relPath(p) {
  if (!p) return p;
  const cwd = process.cwd();
  return p.startsWith(cwd + "/") ? p.slice(cwd.length + 1) : p;
}

/** Collapse runs of blank lines, trim trailing space. */
export const tidy = (lines) =>
  lines.map((l) => l.replace(/\s+$/, ""))
       .filter((l, i, a) => !(l === "" && a[i - 1] === ""));

// CI viewers stamp every line: GitHub Actions writes an ISO timestamp, and
// `gh run view --log` puts tab-separated job and step names in front of it.
// Every parser here anchors on ^, so an unstripped prefix makes all of them
// match nothing and the whole log comes back silent.
const CI_PREFIX = /^(?:[^\t\n]*\t){0,3}\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s/;

/** Strip a uniform CI line prefix, but only when nearly every line carries one -
 *  a log that merely mentions a timestamp must not be mangled. */
export function stripCiPrefix(text) {
  const lines = text.split("\n");
  let seen = 0, stamped = 0;
  for (const l of lines) {
    if (!l.trim()) continue;
    seen++;
    if (CI_PREFIX.test(l)) stamped++;
    if (seen > 200) break;
  }
  // No floor on how many lines a log needs. Requiring three meant a one-line log was
  // never unstamped - and a one-line log is precisely the one whose whole diagnosis is
  // that line, so `git: fatal: not a git repository` came back with nothing at all when
  // it arrived from a GitHub Actions raw log. 11 of the fixtures degraded that way and
  // two lost their diagnosis entirely.
  //
  // The floor was there so a short log that merely mentions a timestamp is not mangled.
  // The ratio still guards that, and the pattern is narrow: a full ISO-8601 instant with
  // the Z, at the very start, followed by whitespace. The worst a wrong strip can do is
  // remove a timestamp and leave the message; not stripping loses the whole diagnosis.
  if (!seen || stamped / seen < 0.8) return text;
  return lines.map((l) => l.replace(CI_PREFIX, "")).join("\n");
}

// A Go test with twenty-four subtests fails twenty-four times with the same assertion,
// and the parser gathers all of them into one message: "Unexpected response." printed
// twenty-four times, 503 characters saying one thing. No diagnosis is improved by
// repeating a sentence, so a run of identical lines becomes the line and a count.
//
// Only consecutive runs, so the shape of a diagnostic that alternates - "expected: X /
// got: Y / expected: Z / got: W" - is left alone. Three is the threshold: saying
// something twice is usually the tool making a point, and annotating it would be noisier
// than the repeat.
const MIN_RUN = 3;

/** Collapse runs of identical lines in a message into one line and a count. */
export function collapseRepeats(message) {
  if (typeof message !== "string" || !message.includes("\n")) return message;
  const lines = message.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; ) {
    let j = i;
    while (j < lines.length && lines[j] === lines[i]) j++;
    const run = j - i;
    out.push(run >= MIN_RUN && lines[i].trim() ? `${lines[i]} (x${run})` : lines[i]);
    if (run >= MIN_RUN && lines[i].trim()) i = j;
    else { out.push(...lines.slice(i + 1, j)); i = j; }
  }
  return out.join("\n");
}
