// Which parsers could read anything from a log, decided before any of them reads it.
//
// Every parser used to be asked about every log. A 10 MiB log of build chatter that none
// of them reads was read whole by all 74 detectors - and then again for each wrapper that
// might have been hiding a tool, 296 readings of the log and 3.3 seconds to say nothing.
//
// So a parser names strings a log has to hold for it to read anything from it: its
// `signals`. If a log holds none of them the parser is not asked. test/router.js holds
// every parser to that - whenever it claims a log, one of its signals is in it - and holds
// the reader to reading every log the same way with the router as without it. A parser
// with no signals is always asked.
//
// One pass over the log answers for the log with any wrapper stripped too. Stripping a
// wrapper takes characters off the start of a line, keeps some of the lines, or puts them
// in another order, and never joins two lines - and a signal holds no line break. A string
// in the stripped log is in the log as given.

const escape = (literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Which of `signals` occur in `text`.
 *
 *  One regex looks ahead for any of them at every position, longest first, so where two
 *  start at the same place the longer is the one it reports - and every shorter one that
 *  starts there is inside it. Once a signal is found it is taken out and the scan goes on
 *  from where it stopped, so the log is read once however many are found. */
export function presentSignals(text, signals) {
  const present = new Set();
  let remaining = [...new Set(signals)].filter((s) => s.length > 0).sort((a, b) => b.length - a.length);
  let from = 0;
  while (remaining.length) {
    const look = new RegExp(`(?=(${remaining.map(escape).join("|")}))`, "g");
    look.lastIndex = from;
    const found = look.exec(text);
    if (!found) break;
    for (const signal of remaining) if (found[1].includes(signal)) present.add(signal);
    remaining = remaining.filter((signal) => !present.has(signal));
    from = found.index + 1;
  }
  return present;
}

let last = { text: null, extractors: null, readers: null };

/** The parsers in `extractors` that could read anything from `text`, in the same order. */
export function readers(text, extractors) {
  if (last.text === text && last.extractors === extractors) return last.readers;
  const present = presentSignals(text, extractors.flatMap((ex) => ex.signals ?? []));
  const found = extractors.filter((ex) => !ex.signals || ex.signals.some((signal) => present.has(signal)));
  last = { text, extractors, readers: found };
  return found;
}
