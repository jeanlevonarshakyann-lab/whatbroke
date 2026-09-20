// uv and Poetry are the two Python dependency resolvers a project uses instead of pip,
// and neither was read. Poetry's failures came back as nothing at all. uv's came back as
// a labelled guess holding the half that says nothing:
//
//   ✗ 1 error (no parser for this tool — best guess)
//       error: No solution found when resolving dependencies
//
// which is true and useless - the package, and why it cannot be had, are on the `cause:`
// line below it, and that line never reached the reader.

import { withSource } from "../ownership.js";

// uv writes a headline and hangs the explanation off it, wrapping the explanation at a
// deeper indent:
//   error: No solution found when resolving dependencies
//     cause: Because requests==2.31.0 depends on urllib3>=1.21.1,<3 ...
//            And because your project depends on urllib3==1.0, ...
const UV_ERROR = /^error:[^\S\n]+(\S.*?)[^\S\n]*$/;
const UV_CAUSE = /^[^\S\n]{2}cause:[^\S\n]+(\S.*?)[^\S\n]*$/;
const UV_MORE = /^[^\S\n]{4,}(\S.*?)[^\S\n]*$/;
// ...except when what it wraps is an echo of the source rather than more of the sentence.
// A TOML error draws the offending line in a gutter, and reading that as prose puts
// "1 | [project" in the middle of a sentence.
const GUTTER = /^(?:\d+[^\S\n]*)?\|/;
// `error: Failed to parse: `pyproject.toml`` names the file in backticks, and the cause
// under it gives the place inside it.
const BACKTICKED = /`([^`\n]+)`/;
const AT_LINE_COLUMN = /\bat[^\S\n]+line[^\S\n]+(\d+),[^\S\n]+column[^\S\n]+(\d+)/;

export const uv = {
  name: "uv",
  // Strings a log has to hold for this parser to read anything from it - see src/router.js.
  signals: ["error:", "cause:"],
  category: "package",
  commands: ["uv"],

  // A bare `error:` belongs to half the tools in existence, so uv's own shape has to be
  // there: its headline with its own `cause:` hanging off it, at uv's indent.
  detect(s) {
    const lines = s.split("\n");
    return lines.some((l, i) => UV_ERROR.test(l) && UV_CAUSE.test(lines[i + 1] ?? ""));
  },

  extract(s) {
    const lines = s.split("\n");
    const failures = [];
    for (let i = 0; i < lines.length; i++) {
      const head = lines[i].match(UV_ERROR);
      if (!head) continue;
      const cause = lines[i + 1]?.match(UV_CAUSE);
      // A headline with nothing hanging off it is not uv's. `error:` at the start of a
      // line belongs to half the tools in existence - cargo ends a failed build with
      // "error: could not compile `shop` due to 2 previous errors" - and in a log where
      // uv ran alongside one of them, reading every `error:` would report the other
      // tool's line as uv's. uv's own always carries its cause.
      //
      // (What keeps uv's duplicate parse error out is not this: uv prints that one twice,
      // once during settings discovery and once as the error that stopped it, and the
      // first is headed `warning:` rather than `error:`.)
      if (!cause) continue;
      const said = [cause[1]];
      let end = i + 2;
      for (let j = i + 2; j < lines.length; j++) {
        const more = lines[j].match(UV_MORE);
        if (!more) break;
        end = j + 1;
        if (GUTTER.test(more[1])) continue;   // the source it echoed, not more sentence
        said.push(more[1]);
      }
      const message = said.join(" ");
      const place = message.match(AT_LINE_COLUMN) ?? head[1].match(AT_LINE_COLUMN);
      failures.push(withSource({
        // The file uv names in the headline - `Failed to parse: `pyproject.toml`` - is
        // the one to open. A headline that names no file leaves this unset rather than
        // borrowing the first backticked word out of a sentence about packages.
        file: /parse|read|open/i.test(head[1]) ? head[1].match(BACKTICKED)?.[1] : undefined,
        line: place ? +place[1] : undefined,
        col: place ? +place[2] : undefined,
        title: head[1], label: head[1], severity: "error", message,
      }, i, end));
    }
    return failures.length ? { tool: "uv", failures } : null;
  },
};

// Poetry states the conflict as a chain and closes it with the same sentence every time:
//   Because shop depends on requests (2.31.0) which depends on urllib3 (>=1.21.1,<3), ...
//   So, because shop depends on urllib3 (1.0), version solving failed.
const PO_OPENS = /^Because\b/;
const PO_CLOSES = /\bversion solving failed\.[^\S\n]*$/;
// Poetry says a broken file in one line, with the path and the place in it.
//   Invalid TOML file /home/dev/shop/pyproject.toml: Unexpected character: ... at line 1 col 8
const PO_INVALID = /^Invalid (\w+) file[^\S\n]+(\S.*?):[^\S\n]+(\S.*?)[^\S\n]*$/;
const AT_LINE_COL = /\bat[^\S\n]+line[^\S\n]+(\d+)[^\S\n]+col[^\S\n]+(\d+)/;

export const poetry = {
  name: "poetry",
  // Strings a log has to hold for this parser to read anything from it - see src/router.js.
  signals: ["version solving failed.", "Invalid TOML file", "Invalid JSON file"],
  category: "package",
  commands: ["poetry"],

  detect: (s) => s.split("\n").some((l) => PO_CLOSES.test(l) || PO_INVALID.test(l)),

  extract(s) {
    const lines = s.split("\n");
    const failures = [];

    const invalid = lines.findIndex((l) => PO_INVALID.test(l));
    if (invalid >= 0) {
      const m = lines[invalid].match(PO_INVALID);
      const place = m[3].match(AT_LINE_COL);
      failures.push(withSource({
        file: m[2], line: place ? +place[1] : undefined, col: place ? +place[2] : undefined,
        title: `invalid ${m[1]} file`, label: `invalid ${m[1]} file`,
        severity: "error", message: m[3],
      }, invalid, invalid + 1));
    }

    // The chain, read from its first "Because" to the sentence that closes it and no
    // further. Without the closing line there is nothing to read: a resolver's prose run
    // to the end of a buffer would take whatever the CI job printed next with it.
    const closes = lines.findIndex((l) => PO_CLOSES.test(l));
    if (closes >= 0) {
      let opens = closes;
      while (opens > 0 && !PO_OPENS.test(lines[opens])) opens--;
      if (PO_OPENS.test(lines[opens])) {
        failures.push(withSource({
          title: "version solving failed", label: "version solving failed", severity: "error",
          message: lines.slice(opens, closes + 1).map((l) => l.trim()).filter(Boolean).join(" "),
        }, opens, closes + 1));
      }
    }

    return failures.length ? { tool: "poetry", failures } : null;
  },
};
