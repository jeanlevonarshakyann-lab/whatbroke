/** Turn a file URL printed in a stack frame back into the path the tool meant.
 *
 * Logs are portable: a Windows log can be analysed on macOS or Linux, so Node's
 * fileURLToPath is the wrong operation here (it applies the host platform's path
 * rules). Decode the URL spelling directly and remove the slash that file URLs put
 * before a Windows drive letter.
 */
export function fileReference(value) {
  let file = String(value ?? "");
  if (file.startsWith("file://")) {
    const reference = file;
    try {
      const url = new URL(reference);
      let path;
      try { path = decodeURIComponent(url.pathname); }
      catch { path = url.pathname; }
      file = url.hostname && url.hostname.toLowerCase() !== "localhost"
        ? `//${url.hostname}${path}`
        : path;
    } catch {
      try { file = decodeURIComponent(reference.slice(7)); }
      catch { file = reference.slice(7); }
    }
  }
  if (/^\/[A-Za-z]:[\\/]/.test(file)) file = file.slice(1);
  return file;
}

/** A Node-style stack frame, including paths that contain spaces.
 *
 * Named frames put the location in parentheses; anonymous frames consist only of the
 * location. Splitting those two forms avoids treating a function name as part of the
 * path while still allowing every character up to the numeric :line:column suffix.
 */
export function nodeFrame(line) {
  const parenthesised = String(line).match(
    /^[^\S\n]*at[^\S\n]+(?:(.*?)[^\S\n]+)?\((.+):(\d+):(\d+)\)[^\S\n]*$/,
  );
  if (parenthesised) {
    return {
      fn: parenthesised[1] || undefined,
      file: fileReference(parenthesised[2]),
      line: +parenthesised[3],
      col: +parenthesised[4],
    };
  }
  const bare = String(line).match(/^[^\S\n]*at[^\S\n]+(.+):(\d+):(\d+)[^\S\n]*$/);
  return bare ? { file: fileReference(bare[1]), line: +bare[2], col: +bare[3] } : null;
}

/** Read a location at the beginning of a line without backtracking across the line.
 *
 * A path regex that accepts arbitrary text retries its remaining grammar at every colon
 * on an untrusted one-line log and can go quadratic. Walk the numeric separators once
 * and let the caller validate the bounded grammar after them. If a path itself contains
 * a numeric-colon sequence, a rejected candidate does not stop the search.
 */
export function locatedPrefix(value, readRest, { column = true } = {}) {
  const text = String(value);
  for (let at = 0; at < text.length; at++) {
    if (text.charCodeAt(at) !== 58) continue; // :
    let end = at + 1;
    while (end < text.length && text.charCodeAt(end) >= 48 && text.charCodeAt(end) <= 57) end++;
    if (end === at + 1 || text.charCodeAt(end) !== 58) continue;
    const line = +text.slice(at + 1, end);
    let col;
    if (column) {
      const start = ++end;
      while (end < text.length && text.charCodeAt(end) >= 48 && text.charCodeAt(end) <= 57) end++;
      if (end === start || text.charCodeAt(end) !== 58) continue;
      col = +text.slice(start, end);
    }
    const file = text.slice(0, at);
    if (!file) continue;
    const detail = readRest(text.slice(end + 1));
    if (detail) return { file, line, ...(column ? { col } : {}), ...detail };
  }
  return null;
}
