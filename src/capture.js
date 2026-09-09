// Capturing a command's output has one job that matters: whatever else is dropped, the
// part that says why it failed has to survive. That part is almost always at the END -
// pytest's summary, cargo's error, jest's failure list, the stack trace. Keeping the
// first N bytes and discarding the rest loses exactly the thing being looked for, and
// it does so precisely on the large logs that are hardest to read by hand.
//
// So the cap is spent from both ends: a slice of the beginning, where the command line
// and the build banner live, and as much of the end as the rest of the budget allows.

const HEAD_SHARE = 0.25;   // the beginning is worth keeping, but the end is worth more

/** Drop a trailing character that the cut left half-written.
 *
 *  Looking at the byte AT the cut is not enough: when the cut is the end of the buffer
 *  there is no byte there to look at, and a buffer ending three bytes into a four-byte
 *  character looks perfectly fine from that angle. Walk back to the last lead byte and
 *  ask whether the character it starts actually finished. */
function trimPartialTrailingChar(buf) {
  let i = buf.length - 1;
  for (let back = 0; i >= 0 && back < 3 && (buf[i] & 0xc0) === 0x80; back++) i--;
  if (i < 0) return buf.subarray(0, 0);
  const lead = buf[i];
  const need = lead < 0x80 ? 1
    : (lead & 0xe0) === 0xc0 ? 2
    : (lead & 0xf0) === 0xe0 ? 3
    : (lead & 0xf8) === 0xf0 ? 4
    : 1;                                  // stray continuation byte: not our problem
  return buf.length - i >= need ? buf : buf.subarray(0, i);
}

/** Byte offset at or after `at` that does not split a UTF-8 character. */
function forwardToCharBoundary(buf, at) {
  let n = Math.max(0, at);
  while (n < buf.length && (buf[n] & 0xc0) === 0x80) n++;
  return n;
}

const NL = 0x0a;

/** Trim the end of `buf` back to the last newline.
 *
 *  A newline can never appear inside a multi-byte UTF-8 sequence - every continuation
 *  byte is >= 0x80 - so cutting on one is encoding-safe for free, and it also hands a
 *  parser whole lines instead of a severed one. Output with no newline at all (a
 *  progress bar, one enormous JSON blob) still has to be cut somewhere; fall back to a
 *  character boundary there. */
function trimEndToLine(buf) {
  const at = buf.lastIndexOf(NL);
  return at === -1 ? trimPartialTrailingChar(buf) : buf.subarray(0, at + 1);
}

/** Drop the leading partial line, so the tail starts where a line does. */
function trimStartToLine(buf) {
  const at = buf.indexOf(NL);
  return at === -1 ? buf.subarray(forwardToCharBoundary(buf, 0)) : buf.subarray(at + 1);
}

/** The gap has to be visible. Joining two halves silently would let a parser read the
 *  head of one failure and the tail of another as a single block and report a diagnosis
 *  that never happened. This line says what is missing and matches no extractor. */
export const elision = (bytes) =>
  `\n~~~ whatbroke: ${bytes} bytes of output elided here (raise --max-bytes to keep them) ~~~\n`;

/** Accumulate at most `maxBytes`, keeping the head and the tail.
 *
 *  Under the cap this is byte-for-byte the input, with no marker and no trimming, so
 *  ordinary runs are completely unaffected. */
export function createCapture(maxBytes) {
  const headMax = Math.max(1, Math.floor(maxBytes * HEAD_SHARE));
  const tailMax = Math.max(1, maxBytes - headMax);
  const head = [];
  let headBytes = 0;
  const tail = [];
  let tailBytes = 0;
  let dropped = 0;

  return {
    push(chunk) {
      let buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
      if (headBytes < headMax) {
        const take = Math.min(headMax - headBytes, buf.length);
        head.push(buf.subarray(0, take));
        headBytes += take;
        buf = buf.subarray(take);
      }
      if (!buf.length) return;
      tail.push(buf);
      tailBytes += buf.length;
      // Ring: shed whole chunks from the front, then part of one, counting every
      // discarded byte so the marker can say how much went missing.
      while (tailBytes > tailMax) {
        const excess = tailBytes - tailMax;
        const first = tail[0];
        if (first.length <= excess) {
          tail.shift();
          tailBytes -= first.length;
          dropped += first.length;
        } else {
          tail[0] = first.subarray(excess);
          tailBytes -= excess;
          dropped += excess;
        }
      }
    },

    finish() {
      const headBuf = Buffer.concat(head);
      const tailBuf = Buffer.concat(tail);
      if (dropped === 0) {
        // Everything fit. Hand back exactly what arrived.
        return { text: Buffer.concat([headBuf, tailBuf]).toString("utf8"), truncated: false, elided: 0 };
      }
      const keptHead = trimEndToLine(headBuf);
      const keptTail = trimStartToLine(tailBuf);
      // Trimming to line boundaries discards a little more; say so honestly.
      const total = dropped + (headBuf.length - keptHead.length) + (tailBuf.length - keptTail.length);
      return {
        text: keptHead.toString("utf8") + elision(total) + keptTail.toString("utf8"),
        truncated: true,
        elided: total,
      };
    },
  };
}
