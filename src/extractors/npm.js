// npm's own failures - a missing script, a bad engine, an unreachable registry.
// Modern npm prefixes every line with "npm error"; older versions used "npm ERR!".
// Neither starts with the word "error", so the generic fallback never matched them
// and the whole run came back silent.
const LINE_RE = /^npm (?:error|ERR!)\s?(.*)$/;
const CODE_RE = /^code[ \t]+(E[A-Z_]+|\d+)[ \t]*$/;
// what npm says after it has already told you the problem
const CHATTER = [
  /^A complete log of this run can be found in/,
  /^To see a list of scripts, run/,
  /^[ \t]*npm run[ \t]*$/,
  /^This is (?:probably not )?a problem with npm/,
  /^Log files were not written/,
  /^errno\s/,
];
const MAX_MESSAGE_LINES = 3;

export default {
  name: "npm",
  detect: (s) => /^npm (?:error|ERR!)\s/m.test(s),

  extract(s) {
    let code = "";
    const msg = [];
    for (const line of s.split("\n")) {
      const m = line.match(LINE_RE);
      if (!m) continue;
      const t = m[1].trim();
      if (!t) continue;
      const c = t.match(CODE_RE);
      if (c) { code ||= c[1]; continue; }
      if (CHATTER.some((re) => re.test(t))) continue;
      if (msg.length < MAX_MESSAGE_LINES) msg.push(t);
    }
    if (!msg.length) return null;
    return {
      tool: "npm",
      summary: undefined,
      failures: [{ title: code, code, severity: "error", message: msg.join("\n") }],
    };
  },
};
