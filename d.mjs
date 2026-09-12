import { readFileSync } from "node:fs";
import { analyse } from "./src/index.js";
for (const p of process.argv.slice(2)) {
  let r=null; try { r = analyse(readFileSync(p, "utf8")); } catch(e) { console.log(p.split("/").pop(), "THREW", e.message); continue; }
  if (!r) { console.log(`${p.split("/").pop()}: NOTHING`); continue; }
  console.log(`${p.split("/").pop()}: tool=${r.tool} | ${r.summary}`);
  for (const f of r.failures) console.log(`   [${f.label ?? f.code ?? f.subject ?? f.title}] ${String(f.message).split("\n")[0].slice(0,110)}`);
}
