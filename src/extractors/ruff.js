// ruff emits rustc-style diagnostics: a header line, then " --> file:line:col".
const HEAD_RE = /^([A-Z]+\d+)(?:[^\S\n]+\[[*x]\])?[^\S\n]+(.+)$/;
// Not everything ruff reports has a rule code. A file it cannot parse is reported as
// `invalid-syntax: unexpected EOF while parsing`, and requiring a code meant a run that
// said "Found 1 error." came back with none at all - which is the ordinary case of
// running ruff over a file with a typo in it.
// Bare error:/help: also precede arrows in other tools; they are not Ruff rules.
const BARE_HEAD_RE = /^(invalid-syntax):[^\S\n]+(.+)$/;
const ARROW_RE = /^[^\S\n]*-->[^\S\n]+(.+?):(\d+):(\d+)[^\S\n]*$/;

export default {
  name: "ruff",
  category: "lint",
  commands: ["ruff"],
  detect: (s) => /^Found \d+ errors?\.?$/m.test(s) && /^[^\S\n]*-->\s/m.test(s),

  extract(s) {
    const lines = s.split("\n");
    // A header is only a header if a location follows it. ruff writes `help:` at column
    // zero too, so the shape alone cannot tell a diagnostic from its own continuation.
    const headerAt = (i) =>
      (ARROW_RE.test(lines[i + 1] ?? "") ? (lines[i].match(HEAD_RE) ?? lines[i].match(BARE_HEAD_RE)) : null);
    const failures = [];
    for (let i = 0; i < lines.length; i++) {
      const h = headerAt(i);
      if (!h) continue;
      const a = lines[i + 1].match(ARROW_RE);
      let fix = "";
      for (let j = i + 2; j < lines.length && !headerAt(j); j++) {
        if (!lines[j].trim() || /^Found \d+ errors?\.?$/.test(lines[j])) break;
        const f = lines[j].match(/^[^\S\n]*help:[^\S\n]*(.+)$/);
        if (f) { fix = f[1]; break; }
      }
      failures.push({
        file: a[1], line: +a[2], col: +a[3],
        title: h[1], code: h[1], severity: "error", message: [h[2], fix].filter(Boolean).join("\n"),
      });
      i++;
    }
    if (!failures.length) return null;
    const sm = s.match(/^Found (\d+) errors?\.?$/m);
    const n = Number(sm ? sm[1] : failures.length);
    return { tool: "ruff", summary: `${n} error${n === 1 ? "" : "s"}`, failures };
  },
};
