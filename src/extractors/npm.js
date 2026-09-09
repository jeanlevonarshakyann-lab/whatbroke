// npm's own failures - a missing script, a bad engine, an unreachable registry.
// Modern npm prefixes every line with "npm error"; older versions used "npm ERR!".
// Neither starts with the word "error", so the generic fallback never matched them
// and the whole run came back silent.
const LINE_RE = /^npm (?:error|ERR!)\s?(.*)$/;
const CODE_RE = /^code[^\S\n]+(E[A-Z_]+|\d+)[^\S\n]*$/;
// what npm says after it has already told you the problem
const CHATTER = [
  /^A complete log of this run can be found in/,
  /^To see a list of scripts, run/,
  /^[^\S\n]*npm run[^\S\n]*$/,
  /^This is (?:probably not )?a problem with npm/,
  /^Log files were not written/,
  /^errno\s/,
];
const MAX_MESSAGE_LINES = 3;

export default {
  name: "npm",
  category: "package",
  commands: ["npm", "pnpm", "yarn"],
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
      // npm only sometimes prints a code (ENOENT, ELIFECYCLE). Without one the failure
      // still has to say what it is, or it reads as unclassified and gets filtered as an
      // unanchored claim when it turns up alongside another tool's output.
      failures: [{
        title: code, ...(code ? { code } : { label: "npm" }),
        severity: "error", message: msg.join("\n"),
      }],
    };
  },
};
