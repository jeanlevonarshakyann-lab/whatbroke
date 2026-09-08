export const ANSI = new RegExp("\\x1b\\[[0-9;]*[a-zA-Z]", "g");
export const stripAnsi = (s) => s.replace(ANSI, "");

/** Node/py internals and vendored code are almost never what you're looking for. */
const NOISE = [
  /node:internal/, /[/\\]node_modules[/\\]/, /[/\\]site-packages[/\\]/,
  /[/\\]lib[/\\]python3\.\d+[/\\]/, /<frozen [a-z_.]+>/,
  /\.pnpm[/\\]/,
];
export const isNoise = (p) => !!p && NOISE.some((re) => re.test(p));

export function relPath(p) {
  if (!p) return p;
  const cwd = process.cwd();
  return p.startsWith(cwd + "/") ? p.slice(cwd.length + 1) : p;
}

/** Collapse runs of blank lines, trim trailing space. */
export const tidy = (lines) =>
  lines.map((l) => l.replace(/\s+$/, ""))
       .filter((l, i, a) => !(l === "" && a[i - 1] === ""));
