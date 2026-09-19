import { stripAnsi } from "./util.js";
// Capturing a command's output has one job that matters: whatever else is dropped, the
// part that says why it failed has to survive. That part is almost always at the END -
// pytest's summary, cargo's error, jest's failure list, the stack trace. Keeping the
// first N bytes and discarding the rest loses exactly the thing being looked for, and
// it does so precisely on the large logs that are hardest to read by hand.
//
// So the cap is spent from both ends, with a bounded set of complete lines around
// probable diagnostics rescued from the middle. The diagnostic copy is only charged
// against the tail when it is actually used, so ordinary logs retain the old 25/75
// split while a buried failure can trade some shutdown noise for the lines that matter.

const HEAD_SHARE = 0.25;   // the beginning is worth keeping, but the end is worth more
const DIAGNOSTIC_SHARE = 0.25;
const CONTEXT_LINES = 8;
// Pretty-printed machine reports put the useful fields after an envelope marker. Eight
// lines is enough context for human diagnostics, but it cut Terraform's JSON halfway
// through its first range and made the otherwise valid report unreadable. Keep a
// bounded larger window after a structured diagnostic array begins; later `severity`
// lines refresh the window for reports with more than one diagnostic.
const STRUCTURED_CONTEXT_LINES = 64;
// What to KEEP when the log is too big to keep all of it. The asymmetry matters: too
// broad costs budget, too narrow loses a failure outright - the opposite of the
// vocabularies the parsers use to decide ownership, where a false claim is the danger.
//
// Burying each captured fixture in three megabytes of build chatter and capping the
// result lost the diagnosis in 25 of 124. Three causes, all of them narrowness:
//
//   - a leading \b cannot match a class name. KeyError, SyntaxError, NoMethodError and
//     AssertionError all carry "Error" behind a word character, and that is how Ruby,
//     Node, Perl and every assertion library announce a failure.
//   - "panic" with a trailing \b does not match Rust's "panicked", and "cannot" does
//     not match "can't".
//   - some tools write no failure word at all. Go says "./main.go:9:2: fmt.Printf call
//     needs 1 arg", jest draws a bullet, and a custom perl die carries only the
//     author's own words - for those, the shape of a location has to stand in.
//
// No alternative starts with \w* or .*: an unanchored pattern finds "Error" inside
// "KeyError" on its own, and a leading \w* only makes the engine retry at every
// position. That mattered - it cost three quarters of the scan's throughput.
const PROBABLE_DIAGNOSTIC = new RegExp([
  "(?:error|exception)s?\\b",
  "\\b(?:fail\\w*|fatal|panic\\w*|traceback|abort\\w*|crash\\w*)\\b",
  "\\b(?:assert\\w*|refused|denied|timed out|not found|no such|unable to)\\b",
  "\\b(?:cannot|can't|(?:could|did|does|is|was|were)\\s?n[o']?t)\\b",
  "\\bsegmentation fault\\b",
  "\\bDATA RACE\\b",
  "\\bdie[ds]?\\b",
  // diagnostic codes: TS2322, CS0103, MSB4018, E0277, F401, SC2086
  "\\b[A-Z]{1,4}\\d{3,5}\\b",
  // a location is a diagnostic by shape, whatever words follow it
  "^\\s*\\.?[\\w./\\\\-]+\\.\\w+:\\d+(?::\\d+)?:",
  "\\bat [\\w./\\\\-]+\\.\\w+ line \\d+",
  // TAP says it with two words that are not otherwise failure vocabulary at all
  "^[^\\S\\n]*not ok\\b",
  // prettier --check writes nothing but "[warn] file.js", and exits non-zero on it. A
  // warning is not a failure, which is why the word is otherwise excluded here - but
  // for deciding what to KEEP, a log made entirely of them has nothing else to keep.
  "^\\[(?:warn|error)\\]",
  // black --check says only "would reformat x.py" and exits non-zero. Nothing in that
  // sentence admits a failure, and it is the entire log.
  "\\bwould (?:reformat|be reformatted|fail to reformat)\\b",
  // git refuses three things in words that hold no failure vocabulary at all, and in
  // each case the refusal is the entire log: "merge: x - not something we can merge"
  // ("can merge" is not "cannot"), "There is no tracking information for the current
  // branch." and "No stash entries found." ("entries found" is not "not found").
  "^(?:merge: .+ - not something we can merge|There is no tracking information|No stash entries found)\\b",
  // make announces its own fatal errors with "***" and ends them "Stop.". Neither
  // half is failure vocabulary, the makefile is often named `Makefile` with no
  // extension so the location pattern above does not match it either, and the whole
  // log is frequently that one line.
  "^(?:make(?:\\[\\d+\\])?:|[^\\s:]+:\\d+:)[^\\S\\n]+\\*\\*\\*[^\\S\\n]",
  // A structured report only means anything whole. eslint's and jest's arrive on one
  // line, so keeping that line keeps the document - but `mocha --reporter json` pretty
  // prints across forty, and dropping the braces between two interesting lines leaves
  // something no parser can read. A line of JSON is cheap to keep and absent from
  // ordinary build chatter, so keeping all of them costs a budget nothing in practice
  // and is the only way a multi-line report survives being buried.
  "^[^\\S\\n]*(?:[{}\\[\\],]+[^\\S\\n]*$|\"[\\w.$-]+\"[^\\S\\n]*:)",
  // Go's tally and the bullets test runners draw carry no word at all
  "^\\s*(?:---\\s*FAIL|FAIL\\b|\\u25cf|\\u2717|\\u2716|\\u00d7)",
  // A tool that refuses to start says why in one sentence and stops. eslint's three
  // are all the log there is, and none of them uses failure vocabulary: an option it
  // does not know, a formatter it no longer ships, a pattern that matched nothing.
  "^Invalid option '",
  "^The \\S+ formatter is no longer part of core\\b",
  "^No files matching the pattern\\b",
  // ...and three more of the same kind, each the whole log of a command that never ran.
  // None of them carries a failure word: the interpreter could not find a module, the go
  // tool was handed a flag it does not have, terraform a subcommand it does not ship.
  "^\\S*python[\\d.]*(?:\\.exe)?: No module named ",
  "^flag provided but not defined: -",
  "^go \\S+: unknown command[^\\S\\n]*$",
  "^(?:Terraform|OpenTofu|Tofu) has no command named \"",
  // ...and a reporter told to write to a file says so and prints nothing else, so that
  // one line is the entire log of a failed run.
  "^[A-Z][A-Z-]* report written to ",
  // deno fmt --check heads each file it would rewrite with "from <file>:" and draws the
  // change under it; the one failure word is in the tally at the very end, so every file
  // but the last was cut from a large log.
  "^from [^\\s:][^\\n]*\\.\\w+:[^\\S\\n]*$",
  // `cargo fmt --check` heads each place with "Diff in <file>:<line>:" and draws a diff
  // under it. There is no failure word in any of it, and the location pattern above wants
  // the path at the start of the line - so a format check buried in a build log lost every
  // place it found, and a one-place run lost the only one it had.
  "^Diff in [^\\s][^\\n]*:\\d+:[^\\S\\n]*$",
  // `gofmt -d` has the same problem and a different shape: it names the file once, in a
  // header with no failure word in it either, and every place it found is an @@ line
  // underneath. Losing the header loses every place in that file, because nothing else
  // in the diff says which file it is about.
  "^diff [^\\s]+\\.orig [^\\s]+[^\\S\\n]*$",
  // `terraform fmt -check -diff` is the same problem a third time. Its header is the pair
  // `--- old/<path>` / `+++ new/<path>`, and the file is named nowhere else in the diff.
  "^--- old/[^\\s][^\\n]*$",
  // go's module loader writes no failure word at all. "go: <module>@<version>: <reason>"
  // and the "go: <package> imports" chain are the whole log of a failed `go mod tidy`,
  // and the chain's own lines are indented, so nothing in it anchors either.
  "^go: \\S+@\\S+:",
  "^go: \\S+ imports[^\\S\\n]*$",
  // VSTest's console is translated into the SDK's thirteen UI languages, and every
  // failure word above is English. What survives translation is the shape: a result line
  // is an indented word or two, the test, and its timing in brackets; the run's tally
  // ends with the assembly it ran and the framework it ran on.
  "^[^\\S\\n]{2}\\S[^\\n]*[^\\S\\n]\\[(?:<[^\\S\\n]+)?\\d+(?:\\.\\d+)?[^\\S\\n]*m?s\\][^\\S\\n]*$",
  "^\\S[^\\n]*![^\\n]*\\.dll[^\\S\\n]+\\((?:net|\\.NET)[^)\\n]*\\)[^\\S\\n]*$",
  // oxlint draws its report the way miette does, and in a pipe it draws it in ASCII: an
  // `x` or a `!`, then the location on the next line in `,-[file:line:col]`. Neither is a
  // failure word, and the rule is spelled `plugin(rule)`. The run ends with a line only
  // oxlint writes, which is all that marks a finding with no rule as oxlint's.
  "^[^\\S\\n]*[x!][^\\S\\n]+[\\w-]+\\([\\w/-]+\\):[^\\S\\n]",
  "^[^\\S\\n]*(?:,-|\\u256d\\u2500)\\[[^\\]\\n]+:\\d+:\\d+\\][^\\S\\n]*$",
  "^Finished in [\\d.]+\\S*s on \\d+ files? with \\d+ rules using \\d+ threads\\.",
  // rubocop --format json is one line, and nothing in it is failure vocabulary: its
  // offenses are conventions and warnings. It opens by naming rubocop.
  "^\\{\"metadata\":\\{\"rubocop_version\":",
  // ...and its simple, quiet and markdown formats name each file in a heading and write
  // each offense under it as a severity letter or word, with no failure word anywhere.
  "^== \\S[^\\n]* ==[^\\S\\n]*$",
  "^[CWEFRI]:[^\\S\\n]*\\d+:[^\\S\\n]*\\d+:[^\\S\\n]",
  "^# RuboCop Inspection Report",
  "^### [^\\n]+ - \\(\\d+ offenses?\\)",
  // sass ends every diagnostic with a trace whose last frame is the root stylesheet, and a
  // module loop draws a box for each file between its message and that trace - more than
  // the eight lines kept after the message, and the trace is how sass's is told apart.
  "^[^\\S\\n]+\\S[^\\n]*[^\\S\\n]\\d+:\\d+[^\\S\\n]+root stylesheet[^\\S\\n]*$",
  "^[^\\S\\n]*\\* \\*\\*Line # \\d+ - \\w+:\\*\\*",
].join("|"), "im");

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

/** How many lines end in `buf`. */
function newlines(buf) {
  let n = 0;
  for (let at = buf.indexOf(NL); at !== -1; at = buf.indexOf(NL, at + 1)) n++;
  return n;
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

/** Accumulate bounded output, keeping the head, probable diagnostic windows and tail.
 *
 *  Under the cap this is byte-for-byte the input, with no marker and no trimming, so
 *  ordinary runs are completely unaffected. */
export function createCapture(maxBytes) {
  const headMax = Math.max(1, Math.floor(maxBytes * HEAD_SHARE));
  const tailMax = Math.max(1, maxBytes - headMax);
  const diagnosticMax = Math.max(1, Math.floor(maxBytes * DIAGNOSTIC_SHARE));
  const scanLineMax = Math.max(1024, Math.min(64 * 1024, diagnosticMax));
  const head = [];
  let headBytes = 0;
  const tail = [];
  let tailBytes = 0;
  let totalBytes = 0;

  // Diagnostic lines are stored with their absolute offsets. Complete lines make the
  // final splice safe for both UTF-8 and multiline parsers; offsets let nearby windows
  // merge without duplicating bytes or pretending two separated regions were adjacent.
  const diagnostics = [];
  const diagnosticOffsets = new Set();
  let diagnosticBytes = 0;
  let recent = [];
  let after = 0;
  let pending = Buffer.alloc(0);
  let pendingStart = 0;
  let pendingWasClipped = false;
  // How many lines have ended so far, which is the line a record starts on.
  let linesEnded = 0;

  const saveDiagnostic = (record) => {
    if (record.start + record.buf.length <= headMax || diagnosticOffsets.has(record.start)) return;
    if (record.buf.length > diagnosticMax - diagnosticBytes) return;
    diagnostics.push(record);
    diagnosticOffsets.add(record.start);
    diagnosticBytes += record.buf.length;
  };

  const considerLine = (view, start) => {
    // Copy a line before retaining it: a subarray of a large stream chunk would keep
    // the entire parent allocation alive and quietly defeat the memory bound.
    const record = { start, buf: Buffer.from(view), line: linesEnded };
    // Decoded as UTF-8, not latin1. A bullet is three bytes - jest's "\u25cf" is
    // e2 97 8f - and latin1 turns those into three separate characters, so a pattern
    // written with the bullet in it can never match. The alternatives for jest's and
    // vitest's markers were added in that state and never once fired; what recovered
    // jest was the "FAIL" on the line above. Decoding correctly costs about a quarter
    // of the decode, which is not where this loop spends its time.
    //
    // Colour codes destroy the word boundaries above too: deno writes
    // "\x1b[31merror\x1b[0m:", where the "m" ending the escape sits against the "e" and
    // \berror never matches. Only pay for that strip when there is an escape to strip.
    const raw = view.toString("utf8");
    const interesting = PROBABLE_DIAGNOSTIC.test(raw.includes("\u001b") ? stripAnsi(raw) : raw);
    if (interesting) {
      saveDiagnostic(record);                 // the diagnostic itself outranks context
      for (let i = recent.length - 1; i >= 0; i--) saveDiagnostic(recent[i]);
      const structured = /^\s*"(?:diagnostics|severity)"\s*:/i.test(raw);
      after = Math.max(after, structured ? STRUCTURED_CONTEXT_LINES : CONTEXT_LINES);
    } else if (after > 0) {
      saveDiagnostic(record);
      after--;
    }
    recent.push(record);
    if (recent.length > CONTEXT_LINES) recent.shift();
  };

  const scanDiagnostics = (buf, start) => {
    if (!pending.length) pendingStart = start;
    pending = pending.length ? Buffer.concat([pending, buf]) : buf;
    let at;
    while ((at = pending.indexOf(NL)) !== -1) {
      const length = at + 1;
      if (!pendingWasClipped) considerLine(pending.subarray(0, length), pendingStart);
      linesEnded++;
      pending = pending.subarray(length);
      pendingStart += length;
      pendingWasClipped = false;
    }
    // An unbroken progress bar or minified blob must not become an unbounded scanner
    // buffer. Such a partial line is not useful context, so retain only enough suffix
    // to find its eventual newline and resume on the next complete line.
    if (pending.length > scanLineMax) {
      const discard = pending.length - scanLineMax;
      pending = Buffer.from(pending.subarray(discard));
      pendingStart += discard;
      pendingWasClipped = true;
      recent = [];
      after = 0;
    }
  };

  return {
    push(chunk) {
      let buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
      const start = totalBytes;
      totalBytes += buf.length;
      scanDiagnostics(buf, start);
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
        } else {
          tail[0] = first.subarray(excess);
          tailBytes -= excess;
        }
      }
    },

    finish() {
      if (pending.length && !pendingWasClipped) considerLine(pending, pendingStart);
      const headBuf = Buffer.concat(head);
      const tailBuf = Buffer.concat(tail);
      if (totalBytes <= maxBytes) {
        // Everything fit. Hand back exactly what arrived.
        return { text: Buffer.concat([headBuf, tailBuf]).toString("utf8"), truncated: false, elided: 0 };
      }
      const keptHead = trimEndToLine(headBuf);
      // Middle diagnostics borrow only the part of the old tail allocation that they
      // need. Candidates already present in the retained tail cost nothing. Moving the
      // tail start can expose another saved line, so find the small monotonic fixed point.
      const ordered = diagnostics.sort((a, b) => a.start - b.start);
      let middle = ordered.filter((record) =>
        record.start >= keptHead.length
        && record.start + record.buf.length <= totalBytes - tailBuf.length);
      let keptTail = Buffer.alloc(0);
      let tailStart = totalBytes;
      for (let pass = 0; pass <= ordered.length; pass++) {
        const middleBytes = middle.reduce((sum, record) => sum + record.buf.length, 0);
        const tailBudget = Math.max(1, maxBytes - keptHead.length - middleBytes);
        const tailOffset = Math.max(0, tailBuf.length - tailBudget);
        const rawTail = tailBuf.subarray(tailOffset);
        keptTail = trimStartToLine(rawTail);
        tailStart = totalBytes - tailBuf.length + tailOffset + (rawTail.length - keptTail.length);
        const next = ordered.filter((record) =>
          record.start >= keptHead.length && record.start + record.buf.length <= tailStart);
        if (next.length === middle.length) break;
        middle = next;
      }

      const spans = [];
      if (keptHead.length) spans.push({ start: 0, buf: keptHead, line: 0 });
      spans.push(...middle);
      if (keptTail.length) spans.push({ start: tailStart, buf: keptTail, line: linesEnded - newlines(keptTail) });

      let text = "";
      let cursor = 0;
      let kept = 0;
      // Which line of the output each line of the text is: runs of lines kept together.
      // A marker's lines are the capture's own, and in no run.
      const segments = [];
      let lineAt = 0;
      for (const span of spans) {
        if (span.start > cursor) {
          const marker = elision(span.start - cursor);
          text += marker;
          lineAt += marker.split("\n").length - 1;
        }
        const overlap = Math.max(0, cursor - span.start);
        if (overlap < span.buf.length) {
          const part = span.buf.subarray(overlap);
          const line = span.line + newlines(span.buf.subarray(0, overlap));
          const ended = newlines(part);
          const count = ended + (part[part.length - 1] === NL ? 0 : 1);
          const last = segments.at(-1);
          if (last && last.at + last.count === lineAt && last.line + last.count === line) last.count += count;
          else segments.push({ at: lineAt, line, count });
          text += part.toString("utf8");
          lineAt += ended;
          kept += part.length;
          cursor = span.start + span.buf.length;
        }
      }
      if (cursor < totalBytes) text += elision(totalBytes - cursor);
      return {
        text,
        truncated: true,
        elided: totalBytes - kept,
        /** Lines [start..end] of `text`, counting from 0, as the runs of the output's own
         *  lines they are - what was elided counted in, and the markers left out. */
        lines: (start, end) => {
          const runs = [];
          for (const { at, line, count } of segments) {
            const from = Math.max(start, at), to = Math.min(end, at + count - 1);
            if (from <= to) runs.push({ start: line + from - at, end: line + to - at });
          }
          return runs;
        },
      };
    },
  };
}
