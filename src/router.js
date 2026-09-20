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

// The signal set is the same on every run - it is every parser's, and parsers do not
// change while the process lives - so what is built from it is built once.
//
// It used to be rebuilt every time a signal was found: the alternation was shrunk to what
// was still missing and recompiled, which makes the rest of one long scan cheaper and
// charges a fresh two-hundred-alternative regex for it. For a short log that construction
// IS the cost, and it was paid several times over. Reading each capture in the corpus once
// took 1,144ms and now takes 22ms; a mixed fifty-kilobyte log takes a quarter of what it
// did. One 400KB log of mostly one tool's output is 7% slower, because shrinking the
// alternation really did help there - which is the whole of what was given up.
//
// `inside` is the other half. The alternation is ordered longest first, so what matches at
// a position is the longest signal starting there and every shorter one is a substring of
// it - which used to be found by asking all two hundred, once per match. Which signals sit
// inside which is a property of the set, so it is worked out once as well.
let prepared = { signals: null, key: null, look: null, inside: null, distinct: [] };
function machinery(signals) {
  // The same list, literally: `readers` hands over the one it keeps, so recognising it by
  // identity skips deduplicating and sorting two hundred and forty strings and writing
  // them out as a key. That bookkeeping was a twentieth of the whole read.
  if (prepared.signals === signals) return prepared;
  const distinct = [...new Set(signals)].filter((s) => s.length > 0).sort((a, b) => b.length - a.length);
  const key = JSON.stringify(distinct);
  if (prepared.key === key) { prepared.signals = signals; return prepared; }
  const inside = new Map();
  for (const longer of distinct) inside.set(longer, distinct.filter((s) => longer.includes(s)));
  prepared = {
    signals,
    key,
    look: new RegExp(`(?=(${distinct.map(escape).join("|")}))`, "g"),
    inside,
    distinct,
  };
  return prepared;
}

/** Which of `signals` occur in `text`.
 *
 *  One regex looks ahead for any of them at every position, longest first, so where two
 *  start at the same place the longer is the one it reports - and every shorter one that
 *  starts there is inside it. The scan goes on from one past each match, so the log is
 *  read once however many are found, and stops as soon as nothing is left to find. */
export function presentSignals(text, signals) {
  const present = new Set();
  const { look, inside, distinct } = machinery(signals);
  if (!distinct.length) return present;
  look.lastIndex = 0;
  let found;
  while ((found = look.exec(text)) !== null) {
    for (const signal of inside.get(found[1])) present.add(signal);
    if (present.size === distinct.length) break;
    look.lastIndex = found.index + 1;
  }
  return present;
}

// The signal list of a set of parsers is that set's, so it is made once and handed to the
// scanner as the same array every time - which is what lets the scanner recognise it
// without looking at what is in it.
let signalList = { extractors: null, signals: null };
const signalsOf = (extractors) => {
  if (signalList.extractors !== extractors) {
    signalList = { extractors, signals: extractors.flatMap((ex) => ex.signals ?? []) };
  }
  return signalList.signals;
};

let last = { text: null, extractors: null, readers: null };

/** The parsers in `extractors` that could read anything from `text`, in the same order. */
export function readers(text, extractors) {
  if (last.text === text && last.extractors === extractors) return last.readers;
  const present = presentSignals(text, signalsOf(extractors));
  const found = extractors.filter((ex) => !ex.signals || ex.signals.some((signal) => present.has(signal)));
  last = { text, extractors, readers: found };
  return found;
}
