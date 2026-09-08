#!/usr/bin/env node
import { spawn } from "node:child_process";
import { analyse } from "../src/index.js";
import { render, setColor } from "../src/render.js";

const argv = process.argv.slice(2);
const HELP = `whatbroke — you ran a command, it printed 400 lines. these are the ones that matter.

  whatbroke <command...>     run it, then distil the failure
  whatbroke -q <command...>  hide the command's own output; show only the distillation
  <command> |& whatbroke     distil output piped in

  -q, --quiet   suppress the wrapped command's output
  -a, --all     don't cap the number of failures shown
  -j, --json    machine-readable output
  -h, --help
`;

const flags = new Set();
while (argv.length && /^-/.test(argv[0])) {
  const a = argv.shift();
  if (a === "--") break;
  for (const f of a.startsWith("--") ? [a] : a.slice(1).split("").map((c) => "-" + c)) flags.add(f);
}
const has = (...names) => names.some((n) => flags.has(n));
if (has("-h", "--help")) { process.stdout.write(HELP); process.exit(0); }

const color = !process.env.NO_COLOR && process.stdout.isTTY;
setColor(color);
const quiet = has("-q", "--quiet");
const opts = { max: has("-a", "--all") ? Infinity : 5 };

function report(raw, code) {
  const r = analyse(raw);
  if (has("-j", "--json")) {
    process.stdout.write(JSON.stringify(r ?? { failures: [] }, null, 2) + "\n");
  } else if (r) {
    process.stdout.write("\n" + render(r, opts));
  } else if (quiet) {
    process.stdout.write(raw);
  }
  process.exit(code);
}

if (argv.length === 0) {
  if (process.stdin.isTTY) { process.stdout.write(HELP); process.exit(0); }
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => (buf += d));
  process.stdin.on("end", () => report(buf, 0));
} else {
  const child = spawn(argv[0], argv.slice(1), { stdio: ["inherit", "pipe", "pipe"] });
  let buf = "";
  const tap = (stream, out) => {
    stream.setEncoding("utf8");
    stream.on("data", (d) => { buf += d; if (!quiet) out.write(d); });
  };
  tap(child.stdout, process.stdout);
  tap(child.stderr, process.stderr);
  child.on("error", (e) => { process.stderr.write(`whatbroke: ${e.message}\n`); process.exit(127); });
  child.on("close", (code) => {
    if (code === 0 && !has("-j", "--json")) process.exit(0);
    report(buf, code ?? 1);
  });
}
