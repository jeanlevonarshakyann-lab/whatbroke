// `node --test` emits TAP with a YAML diagnostic block per failure:
//
//   not ok 59 - rate-limit events fire only once per transition
//     ---
//     location: '/path/test/advanced.ts:1:32121'
//     failureType: 'testCodeFailure'
//     error: |-
//       Expected values to be strictly equal:
//
//       2 !== 1
//     name: 'AssertionError'
//     ...
//
// Everything worth showing is in there; the trick is that `error: |-` is a YAML
// block scalar, so its content is the following lines indented one level deeper.
const NOT_OK_RE = /^(\s*)not ok\s+\d+\s+-\s+(.+?)\s*$/;
const SUBTEST_RE = /^(\s*)# Subtest:\s/;
const FAILURE_TYPE_RE = /^\s*failureType:\s*'(.+?)'\s*$/;
const LOCATION_RE = /^\s*location:\s*'(.+?):(\d+):(\d+)'\s*$/;
const NAME_RE = /^\s*name:\s*'(.+?)'\s*$/;
const ERROR_RE = /^(\s*)error:\s*\|-?\s*$/;
const ERROR_INLINE_RE = /^\s*error:\s*'?(.+?)'?\s*$/;
const KEY_RE = /^\s*[a-zA-Z_]+:\s/;
const MAX_MESSAGE_LINES = 4;

export default {
  name: "node --test",
  detect: (s) => /^#\s+fail\s+\d+\s*$/m.test(s) && /^\s*not ok\s+\d+\s+-\s+/m.test(s),

  extract(s) {
    const lines = s.split("\n");
    const failures = [];
    // TAP prints a suite result after its children. Remember how many failures
    // preceded each scope so only parents with captured children are redundant.
    const scopeStarts = new Map();

    for (let i = 0; i < lines.length; i++) {
      const subtest = lines[i].match(SUBTEST_RE);
      if (subtest) scopeStarts.set(subtest[1].length, failures.length);
      const head = lines[i].match(NOT_OK_RE);
      if (!head) continue;

      let file, line, col, errName = "", failureType;
      const msg = [];
      for (let j = i + 1; j < lines.length && !NOT_OK_RE.test(lines[j]); j++) {
        if (/^\s*\.\.\.\s*$/.test(lines[j])) break;
        const type = lines[j].match(FAILURE_TYPE_RE);
        if (type) { failureType = type[1]; continue; }
        const loc = lines[j].match(LOCATION_RE);
        if (loc) { file = loc[1]; line = +loc[2]; col = +loc[3]; continue; }
        const nm = lines[j].match(NAME_RE);
        if (nm) { errName = nm[1]; continue; }

        const block = lines[j].match(ERROR_RE);
        if (block) {
          // a YAML block scalar: take the lines indented deeper than the key
          const indent = block[1].length;
          for (let k = j + 1; k < lines.length; k++) {
            const text = lines[k];
            const deeper = text.search(/\S/) > indent;
            if (!deeper && text.trim()) break;
            if (text.trim() && msg.length < MAX_MESSAGE_LINES) msg.push(text.trim());
            j = k;
          }
          continue;
        }
        if (!msg.length && ERROR_INLINE_RE.test(lines[j]) && !ERROR_RE.test(lines[j])) {
          msg.push(lines[j].match(ERROR_INLINE_RE)[1]);
          continue;
        }
        if (KEY_RE.test(lines[j])) continue;
      }

      // "AssertionError: Expected values to be strictly equal:" reads better than
      // either half alone, and matches how every other parser here labels a failure
      const message = errName && msg.length && !msg[0].startsWith(errName)
        ? [`${errName}: ${msg[0]}`, ...msg.slice(1)].join("\n")
        : msg.join("\n");

      const start = scopeStarts.get(head[1].length);
      scopeStarts.delete(head[1].length);
      if (failureType === "subtestsFailed" && start !== undefined && failures.length > start) continue;
      failures.push({ file, line, col, title: head[2], message });
    }

    if (!failures.length) return null;

    const count = (k) => {
      const m = s.match(new RegExp(String.raw`^#\s+${k}\s+(\d+)\s*$`, "m"));
      return m ? +m[1] : null;
    };
    const [failed, passed] = [count("fail"), count("pass")];
    const bits = [];
    if (failed) bits.push(`${failed} failed`);
    if (passed) bits.push(`${passed} passed`);

    return { tool: "node --test", summary: bits.length ? bits.join(", ") : undefined, failures };
  },
};
