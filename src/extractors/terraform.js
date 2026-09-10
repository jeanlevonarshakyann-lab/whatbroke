// Terraform draws each diagnostic in a box, and everything inside it is prefixed with a
// vertical bar that is part of the drawing rather than the message:
//
//   ╷
//   │ Error: Missing required argument
//   │
//   │   on main.tf line 1, in resource "local_file" "demo":
//   │    1: resource "local_file" "demo" {
//   │
//   │ The argument "filename" is required, but no definition was found.
//   ╵
//
// Read as prose that comes to "│ Error: Missing required argument" and nothing else -
// no file, no line, and not the sentence at the bottom that says what to do about it.
const BAR = /^[^\S\n]*[│|][^\S\n]?/;
const HEAD_RE = /^[^\S\n]*[│|][^\S\n]*(Error|Warning):[^\S\n]*(.*)$/;
const AT_RE = /^[^\S\n]*on[^\S\n]+(\S+)[^\S\n]+line[^\S\n]+(\d+)(?:,[^\S\n]+in[^\S\n]+(.+?))?:[^\S\n]*$/;
const SRC_RE = /^[^\S\n]*\d+:[^\S\n]?(.*)$/;
const CLOSE_RE = /^[^\S\n]*[╵╷][^\S\n]*$/;
const MAX_MESSAGE = 4;

export default {
  name: "terraform",
  category: "build",
  commands: ["terraform", "tofu", "terragrunt"],

  detect: (s) =>
    HEAD_RE.test(s.split("\n").find((l) => HEAD_RE.test(l)) ?? "") &&
    (/^[^\S\n]*╷[^\S\n]*$/m.test(s) || /[^\S\n]on[^\S\n]+\S+[^\S\n]+line[^\S\n]+\d+/.test(s)),

  extract(s) {
    const lines = s.split("\n");
    const failures = [];
    let warnings = 0;
    for (let i = 0; i < lines.length; i++) {
      const h = lines[i].match(HEAD_RE);
      if (!h) continue;
      let file, line, block, stmt;
      const message = [];
      for (let j = i + 1; j < lines.length; j++) {
        if (CLOSE_RE.test(lines[j]) || HEAD_RE.test(lines[j])) break;
        if (!BAR.test(lines[j])) break;
        const inner = lines[j].replace(BAR, "").trimEnd();
        const at = inner.match(AT_RE);
        if (at) { file ??= at[1]; line ??= +at[2]; block ??= at[3]; continue; }
        const src = inner.match(SRC_RE);
        if (src) { stmt ??= src[1].trim(); continue; }
        if (inner.trim() && message.length < MAX_MESSAGE) message.push(inner.trim());
      }
      if (h[1] !== "Error") { warnings++; continue; }
      failures.push({
        file, line, title: h[2], subject: block, severity: "error",
        // The headline is already the title; repeating it as the first line of the
        // message says it twice. The prose underneath is what it did not say.
        message: (message.length ? message : [h[2]]).join("\n"), stmt,
      });
    }
    if (!failures.length) return null;
    const n = failures.length;
    return {
      tool: "terraform",
      summary: `${n} error${n > 1 ? "s" : ""}` +
        (warnings ? ` — ${warnings} warning${warnings > 1 ? "s" : ""} hidden` : ""),
      failures,
    };
  },
};
