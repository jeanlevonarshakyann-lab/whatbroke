import { relPath } from "./util.js";
import { snippet } from "./snippet.js";

const E = String.fromCharCode(27);
let C = {};
export function setColor(on) {
  const c = (code) => (on ? `${E}[${code}m` : "");
  C = {
    reset: c(0), dim: c(2), bold: c(1),
    red: c(31), green: c(32), yellow: c(33), blue: c(34), cyan: c(36), grey: c(90),
  };
}
setColor(false);

const pad = (n, w) => String(n).padStart(w);

export function render(result, { max = 5, cwd = true } = {}) {
  const out = [];
  const fails = result.failures;

  if (result.summary) {
    out.push(`  ${C.red}${C.bold}✗${C.reset} ${C.bold}${result.summary}${C.reset}`);
  } else if (fails.length) {
    const n = fails.length;
    out.push(`  ${C.red}${C.bold}✗${C.reset} ${C.bold}${n} error${n > 1 ? "s" : ""}${C.reset}` +
             `${result.guessed ? ` ${C.dim}(no parser for this tool — best guess)${C.reset}` : ""}`);
  }
  out.push("");

  for (const f of fails.slice(0, max)) {
    const loc = f.file
      ? `${C.cyan}${cwd ? relPath(f.file) : f.file}${C.reset}${C.dim}:${f.line ?? "?"}${C.reset}`
      : "";
    const title = f.title ? `  ${C.bold}${f.title}${C.reset}` : "";
    if (loc || title) out.push(`  ${loc}${title}`);

    for (const m of String(f.message ?? "").split("\n")) {
      if (m.trim()) out.push(`    ${C.red}${m}${C.reset}`);
    }

    const snip = snippet(f.file, f.line);
    if (snip) {
      out.push("");
      const w = String(snip.at(-1).n).length;
      for (const s of snip) {
        const bar = s.hit ? `${C.red}│${C.reset}` : `${C.dim}│${C.reset}`;
        const num = s.hit ? `${C.red}${pad(s.n, w)}${C.reset}` : `${C.dim}${pad(s.n, w)}${C.reset}`;
        const txt = s.hit ? s.text : `${C.dim}${s.text}${C.reset}`;
        out.push(`      ${num} ${bar} ${txt}`);
        if (s.hit && f.col) out.push(`      ${" ".repeat(w)} ${C.dim}│${C.reset} ${" ".repeat(Math.max(0, f.col - 1))}${C.red}^${C.reset}`);
      }
    } else if (f.stmt) {
      out.push(`      ${C.dim}│${C.reset} ${f.stmt}`);
    }

    if (f.trace?.length > 1) {
      out.push("");
      for (const t of f.trace.slice(1)) out.push(`      ${C.grey}at ${t}${C.reset}`);
    }
    if (f.hiddenFrames > 0) {
      out.push(`      ${C.grey}+ ${f.hiddenFrames} internal frame${f.hiddenFrames > 1 ? "s" : ""} hidden${C.reset}`);
    }
    out.push("");
  }

  if (fails.length > max) {
    out.push(`  ${C.dim}… ${fails.length - max} more (whatbroke --all)${C.reset}`);
    out.push("");
  }
  return out.join("\n");
}
