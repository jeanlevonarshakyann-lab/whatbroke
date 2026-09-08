import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";

/** Output can come from anywhere - a pasted log, a CI artifact, another machine.
 *  Only ever read source from inside the directory we were run in, so crafted
 *  input cannot make us open and print arbitrary files. */
function insideCwd(file) {
  try {
    const root = resolve(process.cwd());
    const target = resolve(root, file);
    return target === root || target.startsWith(root + sep);
  } catch { return false; }
}

const cache = new Map();
/** Files are read once per run. Tests that rewrite a file mid-process need this. */
export const resetSnippetCache = () => cache.clear();
function readLines(file) {
  if (cache.has(file)) return cache.get(file);
  if (!insideCwd(file)) { cache.set(file, null); return null; }
  let lines = null;
  try { lines = readFileSync(file, "utf8").split("\n"); } catch { lines = null; }
  cache.set(file, lines);
  return lines;
}

/** How many lines of source a failure needs either side of the hit.
 *
 *  The message and the source are two ways of answering the same question, and
 *  they compete for the same vertical space. "Argument of type 'string' is not
 *  assignable to parameter of type 'number'." has already answered it — more
 *  source is just noise pushed between you and the next error. "KeyError: 'exp'"
 *  has answered nothing; the code has to do the explaining, so give it room.
 *
 *  Length is a crude proxy for "how much did the tool tell me", but it is the
 *  one signal every extractor produces. Line count counts double on purpose: a
 *  message already three lines tall has both said a lot and spent the budget. */
export function contextFor(message) {
  const msg = String(message ?? "").trim();
  if (!msg) return 3;                                  // said nothing at all
  const lines = msg.split("\n").filter((l) => l.trim()).length;
  if (lines >= 3 || msg.length >= 70) return 1;        // explains itself, and it's tall
  if (msg.length >= 40) return 2;                      // says something useful
  return 4;                                            // bare — the source is the explanation
}

/** Return [{n,text,hit}] around `line`, or null if unreadable. */
export function snippet(file, line, ctx = 2) {
  if (!file || !line) return null;
  const all = readLines(file);
  if (!all) return null;
  const start = Math.max(1, line - ctx);
  const end = Math.min(all.length, line + ctx);
  const out = [];
  for (let n = start; n <= end; n++) out.push({ n, text: all[n - 1] ?? "", hit: n === line });
  // Wide context must not spill into the next function. A blank line is the
  // cheapest block boundary that holds across every language we parse.
  if (ctx > 2) {
    const hit = out.findIndex((o) => o.hit);
    let end = out.length;
    for (let i = hit + 1; i < out.length; i++) {
      if (out[i].text.trim() === "") { end = i; break; }
    }
    let start = 0;
    for (let i = hit - 1; i >= 0; i--) {
      if (out[i].text.trim() === "") { start = i + 1; break; }
    }
    out.splice(end);
    out.splice(0, start);
  }

  while (out.length && out[0].text.trim() === "" && !out[0].hit) out.shift();
  while (out.length && out.at(-1).text.trim() === "" && !out.at(-1).hit) out.pop();
  return out.length ? out : null;
}
