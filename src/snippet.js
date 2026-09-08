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

/** Return [{n,text,hit}] around `line`, or null if unreadable. */
export function snippet(file, line, ctx = 2) {
  if (!file || !line) return null;
  const all = readLines(file);
  if (!all) return null;
  const start = Math.max(1, line - ctx);
  const end = Math.min(all.length, line + ctx);
  const out = [];
  for (let n = start; n <= end; n++) out.push({ n, text: all[n - 1] ?? "", hit: n === line });
  while (out.length && out[0].text.trim() === "" && !out[0].hit) out.shift();
  while (out.length && out.at(-1).text.trim() === "" && !out.at(-1).hit) out.pop();
  return out.length ? out : null;
}
