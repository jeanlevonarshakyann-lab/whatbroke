// `mocha --reporter xunit`. The node parser was claiming these logs, because the stack
// inside the <failure> body looks exactly like one of node's - so the failure came back
// titled "AssertionError [ERR_ASSERTION]", with the test's name nowhere, no count of what
// passed, and XML markup left in the message.
//
// mocha names itself in the root element - `<testsuite name="Mocha Tests">` - which is
// what tells this apart from every other tool that writes a JUnit-shaped report.
import { xmlText, xmlAttributes, isNoise } from "../util.js";

const ROOT_RE = /<testsuite\b[^>]*\bname="Mocha Tests"/;
const FRAME_RE = /^[^\S\n]+at[^\S\n]+(?:(.+?)[^\S\n]+\()?(.+?):(\d+):(\d+)\)?[^\S\n]*$/;
const MAX_MESSAGE_LINES = 3;

export default {
  name: "mocha xunit",
  category: "test",
  commands: ["mocha"],

  detect: (s) => ROOT_RE.test(s),

  extract(s) {
    const lines = s.split("\n");
    const failures = [];
    let root;
    for (let i = 0; i < lines.length; i++) {
      if (!root && ROOT_RE.test(lines[i])) { root = xmlAttributes(lines[i]); continue; }
      if (!root || !/<testcase\b/.test(lines[i])) continue;
      const test = xmlAttributes(lines[i]);
      // The body starts on the same line as the tag and runs until </failure>. A test
      // that passed is written as a self-closing tag with no body at all.
      const open = lines[i].match(/<(failure|error)\b[^>]*>([\s\S]*)$/);
      if (!open) continue;
      const closer = new RegExp(`</${open[1]}>`);
      const body = [open[2]];
      let end = i;
      while (end < lines.length && !closer.test(body.at(-1))) body.push(lines[++end] ?? "");
      const decoded = xmlText(body.join("\n").replace(new RegExp(`</${open[1]}>[\\s\\S]*$`), ""));
      const text = decoded.split("\n");
      let file, line, col;
      const message = [];
      for (const raw of text) {
        const frame = raw.match(FRAME_RE);
        if (frame) {
          if (!file && !isNoise(frame[2])) { file = frame[2]; line = +frame[3]; col = +frame[4]; }
          continue;
        }
        const t = raw.trim();
        // The class and message are repeated below the diff; the first telling is enough.
        if (t && message.length < MAX_MESSAGE_LINES && !message.includes(t)) message.push(t);
      }
      const name = [test.classname, test.name].filter(Boolean).join(" ").trim() || "test";
      failures.push({
        file: file ?? test.file, line, col,
        title: name, subject: name, severity: "error",
        message: message.join("\n") || name,
      });
      i = end;
    }
    if (!failures.length) return null;
    const count = (key) => (/^\d+$/.test(root?.[key] ?? "") ? +root[key] : 0);
    // mocha files an assertion under `errors` and a reporter failure under `failures`.
    // Both are tests that did not pass, and the headline is what mocha's own reporters
    // would have printed for the same run.
    const failing = count("failures") + count("errors");
    const passing = Math.max(0, count("tests") - failing - count("skipped"));
    return {
      tool: "mocha",
      summary: `${failing || failures.length} failing, ${passing} passing`,
      failures,
    };
  },
};
