// Copying the wrapped command's output to the terminal, at the terminal's pace.
//
// `whatbroke -- <command>` streams the command's own output through live, so a build that
// prints for two minutes still looks like a build that prints for two minutes. The copy
// kept for diagnosis is capped by --max-bytes; the live copy was not capped by anything.
//
// write() returns false when the destination's buffer is full - a pipe into a slow
// reader, a file on a busy disk, a terminal that is not being drained - and the old code
// ignored it. Node then queued every later chunk in this process's memory, so wrapping a
// command that writes faster than the reader reads grew whatbroke's heap without limit,
// which is the one thing --max-bytes exists to prevent.
//
// A stream nobody is reading has to stop being read. Pausing the child's pipe fills the
// operating system's buffer and then blocks the child itself, which is what backpressure
// is for: the producer waits for the consumer, and nothing is queued in between.

/** Copy `stream` to `out`, pausing when `out` is full. `tee` sees every chunk whether or
 *  not it is written on, so what is captured never depends on what the terminal did. */
export function relay(stream, out, { suppress = false, tee } = {}) {
  let waiting = false;
  stream.on("data", (chunk) => {
    tee?.(chunk);
    if (suppress) return;
    if (out.write(chunk) !== false || waiting) return;
    // One pending resume at a time: a paused stream emits no further data, so there is
    // never a second chunk to queue a second listener for.
    waiting = true;
    stream.pause();
    out.once("drain", () => { waiting = false; stream.resume(); });
  });
  return stream;
}
