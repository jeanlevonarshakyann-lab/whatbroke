import { openSync, readSync, fstatSync, closeSync, realpathSync, constants } from "node:fs";
import { resolve, sep } from "node:path";

// A source file bigger than this is generated, minified or vendored, and a caret
// inside one explains nothing. Checked with fstat before a byte is allocated, so an
// enormous file costs a stat rather than its own size in memory.
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Output can come from anywhere - a pasted log, a CI artifact, another machine.
 *  Only ever read source from inside the directory we were run in, so crafted
 *  input cannot make us open and print arbitrary files.
 *
 *  realpath is what makes that hold. resolve() alone collapses `..` but knows
 *  nothing about links, so a symlink sitting inside the tree - or a symlinked
 *  parent directory - used to pass the prefix test while pointing anywhere on the
 *  disk. Canonicalising both sides also fixes the mirror-image case: a working
 *  directory reached through a link (/tmp on macOS is really /private/tmp) no
 *  longer rejects the very files it contains. */
function safePath(file) {
  try {
    const root = realpathSync(resolve(process.cwd()));
    const target = realpathSync(resolve(root, file));
    return target === root || target.startsWith(root + sep) ? target : null;
  } catch { return null; }
}

// O_NOFOLLOW: the canonical path contains no links by construction, so this only has
// to survive the window between realpath and open. O_NONBLOCK: opening a FIFO for
// reading otherwise waits for a writer that never comes, and whatbroke hangs forever
// on a log that merely names one. Neither constant exists on Windows.
const READ_FLAGS = constants.O_RDONLY
  | (constants.O_NOFOLLOW ?? 0)
  | (constants.O_NONBLOCK ?? 0);

/** Read a whole regular file, or null. Every refusal is silent on purpose: the
 *  caller keeps the diagnostic and simply shows no source. */
function readBounded(path) {
  let fd;
  try {
    fd = openSync(path, READ_FLAGS);
    const st = fstatSync(fd);
    // Ask the descriptor, not the path: the answer then describes the file actually
    // opened. A directory, socket, FIFO or device is not source, and is not read.
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    const buf = Buffer.allocUnsafe(st.size);
    let got = 0;
    while (got < st.size) {
      const n = readSync(fd, buf, got, st.size - got, got);
      if (n <= 0) break;   // truncated under us; show what we got
      got += n;
    }
    return buf.subarray(0, got).toString("utf8");
  } catch { return null; }
  finally { if (fd !== undefined) { try { closeSync(fd); } catch { /* already gone */ } } }
}

const cache = new Map();
/** Files are read once per run. Tests that rewrite a file mid-process need this. */
export const resetSnippetCache = () => cache.clear();
function readLines(file) {
  if (cache.has(file)) return cache.get(file);
  const path = safePath(file);
  const text = path === null ? null : readBounded(path);
  // Lines are returned whole. The file cap already bounds them, and clipping here
  // would corrupt the staleness check: comparing a 512-character prefix reports an
  // edit past that point as no edit at all. Narrowing for display is render's job.
  const lines = text === null ? null : text.split("\n");
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
