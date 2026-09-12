import { findJsonDocument } from "../util.js";
// npm's own failures - a missing script, a bad engine, an unreachable registry.
// Modern npm prefixes every line with "npm error"; older versions used "npm ERR!".
// Neither starts with the word "error", so the generic fallback never matched them
// and the whole run came back silent.
const LINE_RE = /^npm (?:error|ERR!)\s?(.*)$/;
// npm's codes are not all words. ERESOLVE and ENOENT are, but a registry failure is
// E404, E401, E403 - and a pattern written E[A-Z_]+ matches none of those, so the line
// naming the code was read as the first line of the MESSAGE and the failure carried no
// code at all. What npm declares there is "code" and then whatever it calls it.
const CODE_RE = /^code[^\S\n]+([A-Z][A-Z0-9_]*|\d+)[^\S\n]*$/;
// what npm says after it has already told you the problem
const CHATTER = [
  /^A complete log of this run can be found in/,
  /^To see a list of scripts, run/,
  /^[^\S\n]*npm run[^\S\n]*$/,
  /^This is (?:probably not )?a problem with npm/,
  /^Log files were not written/,
  /^errno\s/,
  // npm's standing advice for a package it could not fetch. It is the same two lines
  // whatever the package was, and keeping them spends the message on saying nothing.
  /^Note that you can also install from a$/,
  /^tarball, folder, http url, or git url\.$/,
];
const MAX_MESSAGE_LINES = 3;

// `npm --json` writes its diagnosis twice: the same "npm error" block on stderr, and a
// document on stdout. A pipeline that keeps only stdout keeps only the document - and
// nothing read it, so a failed install came back with no diagnosis at all.
//
// The shape is npm's own: an object whose only business is an `error` carrying the code
// it just printed, a one-line summary and the detail under it.
const REPORT = (v) => !!v && typeof v === "object" && !Array.isArray(v) && !!v.error &&
  typeof v.error === "object" && typeof v.error.code === "string" &&
  typeof v.error.summary === "string" && typeof v.error.detail === "string";
const report = (s) => s.includes('"summary"') ? findJsonDocument(s, REPORT) : null;

export default {
  name: "npm",
  category: "package",
  commands: ["npm", "pnpm", "yarn"],
  commandHints: [],
  detect: (s) => /^npm (?:error|ERR!)\s/m.test(s) || report(s) !== null,

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
      msg.push(t);
    }
    // npm repeats the code in front of every line of the block it belongs to -
    // "npm error 404 Not Found - GET ..." - and prints the bare code on the lines
    // between them. Once the code is the code, saying it again on every line is noise -
    // and the noise was being counted against the budget below, so the lines that said
    // WHICH package could not be fetched fell off the end of a three-line message.
    // A registry failure is coded E404 and then prefixed 404, because the number is the
    // HTTP status underneath it. That is the only case where the two differ, and it is
    // bounded to it: EPERM is not stripped down to PERM.
    const repeated = [code, /^E\d+$/.test(code) ? code.slice(1) : null].filter(Boolean);
    const said = [];
    for (const line of msg) {
      let without = line;
      for (const token of repeated) {
        if (without === token) { without = ""; break; }
        without = without.replace(new RegExp(`^${token}[^\\S\\n]+`), "").trim();
      }
      // ...and only then is it chatter or not. npm prints its standing advice behind the
      // same repeated prefix as the diagnosis, so a chatter test run before the prefix
      // came off never matched it, and half the message was spent on it.
      if (!without || CHATTER.some((re) => re.test(without))) continue;
      said.push(without);
      if (said.length >= MAX_MESSAGE_LINES) break;
    }

    // The document says the same thing, so it is only read when the block is not there.
    // Where both are, the block is what npm showed the person running it.
    if (!said.length) {
      const doc = report(s);
      if (!doc) return null;
      const detail = doc.error.detail.split("\n").map((l) => l.trim())
        .filter((l) => l && !CHATTER.some((re) => re.test(l)));
      return {
        tool: "npm",
        summary: undefined,
        failures: [{
          title: doc.error.code, code: doc.error.code, severity: "error",
          message: [doc.error.summary.trim(), ...detail].slice(0, MAX_MESSAGE_LINES).join("\n"),
        }],
      };
    }
    return {
      tool: "npm",
      summary: undefined,
      // npm only sometimes prints a code (ENOENT, ELIFECYCLE). Without one the failure
      // still has to say what it is, or it reads as unclassified and gets filtered as an
      // unanchored claim when it turns up alongside another tool's output.
      failures: [{
        title: code, ...(code ? { code } : { label: "npm" }),
        severity: "error", message: said.join("\n"),
      }],
    };
  },
};
