import { readFileSync } from "node:fs";

const cache = new Map();
function readLines(file) {
  if (cache.has(file)) return cache.get(file);
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
