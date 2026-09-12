import { uniqueFailures } from "../util.js";

const PROB_RE = /^[^\S\n]+(\d+):(\d+)[^\S\n]+(error|warning)[^\S\n]+(.+?)\s{2,}([\w@/-]+)[^\S\n]*$/;

// eslint reports a broken config by crashing, so the log is a Node stack pointing into
// eslint's own internals - and the node parser then reports node_modules/eslint/lib/... ,
// which is true and useless. The line that matters is the one under the banner.
const CONFIG_BANNER = /^Oops! Something went wrong!/m;
const CONFIG_ERROR = /^([A-Z]\w*Error): (.+)$/;
// Not every refusal is a crash. eslint can also stop before it lints anything and just
// say why, in a sentence with no error class, no location and no stack - and a log that
// holds only that came back "could not identify a diagnostic", over a command that
// exited 2 and told you exactly what was wrong with it.
//
// Each of these names eslint or its own option in the text, which is what makes the
// sentence eslint's rather than any other tool's prose.
const REFUSALS = [
  // `Invalid option '--bogus' - perhaps you meant '--flag'?`
  [/^Invalid option '(-[^']*)'.*$/m, "invalid option"],
  // `The unix formatter is no longer part of core ESLint. Install it manually with ...`
  [/^The \S+ formatter is no longer part of core ESLint\..*$/m, "formatter not installed"],
  // Printed under the banner, where the crash form would put an error class.
  [/^No files matching the pattern .+ were found\.$/m, "no files matched"],
];

/** The sentence eslint stopped on, when it stopped without crashing. */
function refusal(s) {
  for (const [pattern, label] of REFUSALS) {
    const m = s.match(pattern);
    if (!m) continue;
    // The advice under it is part of the answer - "Please check for typing mistakes in
    // the pattern." says what to do next - and eslint writes it on the very next line.
    // Taking the next non-blank line however far away it was is not a bound: in a log
    // that holds a second tool, that line is the second tool's first line, and eslint
    // reported it as its own advice in 596 of the sweep's ordered pairs.
    const lines = s.split("\n");
    const at = lines.findIndex((l) => l === m[0]);
    const next = at >= 0 ? lines[at + 1] : undefined;
    const advice = next && next.trim() && !/^\s*(?:at\s|[A-Z]\w*Error:)/.test(next) ? next.trim() : null;
    return { title: label, label, severity: "error", message: [m[0], advice].filter(Boolean).join(" ") };
  }
  return null;
}

export default {
  name: "eslint",
  category: "lint",
  commands: ["eslint"],
  detect: (s) => /^[^\S\n]*[✖x][^\S\n]+\d+ problems? \(/m.test(s) || PROB_RE.test(s) ||
    (CONFIG_BANNER.test(s) && /^ESLint: /m.test(s)) || refusal(s) !== null,

  extract(s) {
    // A configuration error used to end the read: eslint that cannot load its config
    // does not go on to lint anything, so there was nothing else in the log to find.
    // There is when the log holds more than one run of it - `pnpm -r lint` puts every
    // package's output in one place - and returning early there threw away 90 real
    // findings from the packages whose config was fine.
    const configFailures = [];
    if (CONFIG_BANNER.test(s)) {
      const lines = s.split("\n");
      const banner = lines.findIndex((l) => CONFIG_BANNER.test(l));
      // A previous command may also have thrown a TypeError. ESLint's configuration
      // exception is the first one after its own banner, never before it - and not just
      // the first one SOMEWHERE after it. eslint prints its version under the banner and
      // the reason on the first line below that, so the reason is that line or there is
      // none: scanning onward found the next tool's exception in a log that held two,
      // and reported it as eslint's configuration error.
      const version = lines.slice(banner + 1).findIndex((l) => /^ESLint: /.test(l));
      const from = version < 0 ? banner : banner + 1 + version;
      const relative = lines.slice(from + 1).findIndex((l) => l.trim());
      const at = relative < 0 || !CONFIG_ERROR.test(lines[from + 1 + relative]) ? -1 : from + 1 + relative;
      if (at >= 0) {
        const m = lines[at].match(CONFIG_ERROR);
        configFailures.push({ title: m[1], code: m[1], severity: "error", message: m[2] });
      }
    }
    // ...and the refusals that are not crashes. The banner form is preferred where both
    // appear, since an error class and its message say more than the sentence under it.
    if (!configFailures.length) {
      const stopped = refusal(s);
      if (stopped) configFailures.push(stopped);
    }
    const lines = s.split("\n");
    const failures = [];
    let file = null;
    const warningLines = new Set();

    for (const l of lines) {
      const p = l.match(PROB_RE);
      if (p) {
        if (p[3] === "warning") {
          warningLines.add(JSON.stringify([file, +p[1], +p[2], p[4], p[5]]));
          continue;   // errors are what block you
        }
        failures.push({ file, line: +p[1], col: +p[2], title: p[5], code: p[5], severity: p[3], message: p[4] });
        continue;
      }
      if (l.trim() && !/^\s/.test(l) && !/^[✖x✔]/.test(l.trim())) file = l.trim();
    }

    const tableFailures = uniqueFailures(failures);
    const warnings = warningLines.size;
    let summary;
    const m = s.match(/^[^\S\n]*[✖x][^\S\n]+(\d+ problems? \(.+?\))[^\S\n]*$/m);
    if (m) summary = m[1];
    if (!tableFailures.length && !configFailures.length) return null;
    if (warnings) summary = `${summary ?? `${tableFailures.length} errors`} — ${warnings} warning${warnings > 1 ? "s" : ""} hidden`;
    // The config error is why eslint stopped, so it leads; anything it did manage to
    // lint before or after follows it rather than being dropped.
    if (configFailures.length) {
      // "invalid option" describes what was wrong; it does not say the run failed, and
      // the guarantees suite rejects a headline that reads like nothing happened.
      const why = configFailures[0].code ? "configuration error" : `eslint refused to run — ${configFailures[0].label}`;
      summary = tableFailures.length
        ? `${why} — ${summary ?? `${tableFailures.length} problems`} elsewhere`
        : why;
    }
    return { tool: "eslint", summary, failures: uniqueFailures([...configFailures, ...tableFailures]) };
  },
};
