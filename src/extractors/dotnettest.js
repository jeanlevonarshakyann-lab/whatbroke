// `dotnet test` under Microsoft.Testing.Platform. The shape is:
//
//   failed Namespace.Class.Method (11ms)
//     Assert.Equal() Failure: Values differ
//     Expected: Transient
//     Actual:   Singleton
//     from /path/to/Tests.dll (net10.0|arm64)
//     ...the same message again, indented differently...
//       at Namespace.Class.Method() in /path/Tests.cs:395
//       at System.Reflection.MethodBaseInvoker...        <- framework noise
//
// The message is printed twice, once plainly and once re-indented under `from`.
// Only the first copy is kept, and only the frame in the user's own code is used
// for the location.
//
// VSTest uses `Failed Namespace.Class.Method [2 ms]`, followed by labelled Error
// Message and Stack Trace blocks. It may also print xUnit's prefixed copy first; the
// labelled result is the stable cross-framework surface and is the one parsed below.
import { joinSources, withSource } from "../ownership.js";
import { elements, firstElement, lineAt, xmlAttributes, xmlText } from "../util.js";

const MTP_FAILED_RE = /^failed[^\S\n]+(\S+)[^\S\n]+\((\d+(?:\.\d+)?)[^\S\n]*m?s\)[^\S\n]*$/;
// Microsoft.Testing.Platform speaks the SDK's languages too, and translates more than
// VSTest does - the outcome, the line naming the assembly, the summary, and the stack
// frames themselves:
//
//   failed TotalsAnInvoice (11ms)                  fehlerhaft TotalsAnInvoice (7ms)
//     from /app/ShopTests.dll (net10.0|arm64)        von /app/ShopTests.dll (net10.0|arm64)
//       at ShopTests.CartTests.TotalsAnInvoice() in /app/Test1.cs:9
//                                                    um ShopTests.CartTests.TotalsAnInvoice() in /app/Test1.cs:9
//   Test run summary: Failed!                      Testlaufzusammenfassung: Fehler!
//
// and "operazione non riuscita", "場所: ... 場所: /app/Test1.cs:9", "şu yöntemle: ...
// şu dosyada: ...". Only the English words were read, so a failed run in any of the other
// thirteen came back with nothing at all.
//
// What no language changes is the assembly line under a result: two spaces, a word or
// two, the path to a .dll and its target framework and architecture in brackets. That
// says the heading is a result - and under --output detailed a passing test has one too,
// so it does not say which. What only a failure has is a stack. A heading with both under
// it is a failure, and its first words are the outcome in the run's language - which
// then reads every other heading that uses them.
const MTP_ANY_HEAD_RE = /^([^\s/\\()]+(?:[^\S\n]+[^\s/\\()]+){0,2})[^\S\n]+(\S+)[^\S\n]+\((\d+(?:\.\d+)?)[^\S\n]*m?s\)[^\S\n]*$/;
const MTP_FROM_RE = /^[^\S\n]{2}\S[^\n]*\.dll[^\S\n]+\([^()|\n]+\|[^()\n]+\)[^\S\n]*$/;
// A frame in any language: four spaces, a word or two, the method and its arguments, a
// word or two, and the absolute path and line.
const MTP_FRAME_RE = /^[^\S\n]{4}(?:[^\s(]+[^\S\n]+){1,2}([^\s(]+)\([^\n]*\)[^\S\n]+(?:[^\s(]+[^\S\n]+){1,2}((?:\/|[A-Za-z]:[\\/])[^\n]*?):(\d+)[^\S\n]*$/;
// "Test run summary: Failed!", then the counts one to a line - total, failed, succeeded,
// skipped - in that order in every language.
const MTP_TALLY_RE = /^\S[^\n]*[:\uFF1A][^\S\n]*\S[^\n]*![^\S\n]*\n((?:[^\S\n]{2}\S[^\n]*?[:\uFF1A][^\S\n]*\d+[^\S\n]*\n){4})/m;

/** The outcome words that head a failure in this log, in whatever languages it holds. */
function mtpFailWords(lines) {
  const words = new Set(["failed"]);
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i].match(MTP_ANY_HEAD_RE);
    if (!head || words.has(head[1])) continue;
    let from = false, frame = false;
    for (let j = i + 1; j < lines.length && !MTP_ANY_HEAD_RE.test(lines[j]); j++) {
      from ||= MTP_FROM_RE.test(lines[j]);
      frame ||= MTP_FRAME_RE.test(lines[j]) || AT_RE.test(lines[j]);
      if (from && frame) { words.add(head[1]); break; }
    }
  }
  return words;
}

/** The heading of a failed test, in any of the log's languages, or null. */
const mtpHead = (line, words) => {
  const head = line.match(MTP_ANY_HEAD_RE);
  return head && words.has(head[1]) ? [head[0], head[2], head[3]] : null;
};
const VSTEST_FAILED_RE = /^[^\S\n]+Failed[^\S\n]+(.+?)[^\S\n]+\[(?:<[^\S\n]+)?\d+(?:\.\d+)?[^\S\n]*(?:ms|s)\][^\S\n]*$/;
const VSTEST_RESULT_RE = /^[^\S\n]+(?:Failed|Passed|Skipped)[^\S\n]+.+?[^\S\n]+\[(?:<[^\S\n]+)?\d+(?:\.\d+)?[^\S\n]*(?:ms|s)\][^\S\n]*$/;
const VSTEST_END_RE = /^(?:Test Run Failed\.|Failed![^\n]*\bFailed:[^\S\n]*\d+)/m;
// The .NET SDK speaks thirteen languages, and every word VSTest's console writes goes
// with it: "Failed" becomes "Fehler", "失敗", "Не пройден"; "Error Message:" becomes
// "Fehlermeldung:", "エラー メッセージ:", "Message d'erreur :". Reading only the English
// words meant `dotnet test` under any other UI language came back with no diagnosis at
// all - three failed tests, nothing reported.
//
// A dictionary of thirteen languages is not the answer, and it is not needed. The run
// closes with a tally whose first word is the failure word in the run's own language,
// followed by the same counts in the same order in every one of them, and the assembly:
//
//   Failed!  - Failed:     3, Passed:     0, Skipped:     0, Total:     3, ... - x.dll (net10.0)
//   Fehler!      : Fehler:     3, erfolgreich:     0, übersprungen:     0, gesamt:     3, ...
//   Не пройден!: не пройдено     3, пройдено     0, пропущено     0, всего     3, ...
//
// So the word is read from the tally, and the result lines are read with that word. The
// labels are read by position - the first one opens the message, the next one the stack -
// since what they say is translated and where they stand is not.
const VSTEST_TALLY_RE = /^([^\s!][^\n!]*?)![^\n]*[^\S\n]-[^\S\n]+\S+\.dll[^\S\n]+\([^)\n]*\)[^\S\n]*$/m;
// A result line in any language: an indented word or two, the test, and its timing.
const VSTEST_ANY_RESULT_RE = /^[^\S\n]{2}\S[^\n]*?[^\S\n]+\[(?:<[^\S\n]+)?\d+(?:\.\d+)?[^\S\n]*(?:ms|s)\][^\S\n]*$/;
// A label: two spaces in, some words, a colon, and nothing after it.
const VSTEST_LABEL_RE = /^[^\S\n]{2}\S[^\n]*?[^\S\n]*:[^\S\n]*$/;
const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const AT_RE = /^[^\S\n]*at[^\S\n]+(.+?)[^\S\n]+in[^\S\n]+(.+?):(?:line[^\S\n]+)?(\d+)[^\S\n]*$/;
const FRAMEWORK = /^(?:System\.|Microsoft\.|Xunit\.|NUnit\.|InternalAutoGenerated)/;
const MAX_MESSAGE_LINES = 4;

// --logger trx writes the run as a document, and it is the artifact a .NET CI job keeps.
// Nothing read it: a run with three failed tests came back with no diagnosis at all.
//
// The document declares itself in its own namespace, which is the bound - a <TestRun>
// element on its own is not evidence of anything. Each result carries the test's name
// and outcome as attributes and its message and stack as elements, so the location comes
// from the same first-frame-in-your-own-code rule the console output is read with.
const TRX_DOC = /<TestRun\b[^>]*\bxmlns="http:\/\/microsoft\.com\/schemas\/VisualStudio\/TeamTest\//;
const TRX_RESULT_RE = /<UnitTestResult\b([^>]*?)(?:\/>|>([\s\S]*?)<\/UnitTestResult>)/g;
const TRX_MESSAGE_RE = /<Message>([\s\S]*?)<\/Message>/;
const TRX_STACK_RE = /<StackTrace>([\s\S]*?)<\/StackTrace>/;
const TRX_RESULT = { open: /<UnitTestResult\b/, close: () => "</UnitTestResult>", selfClosing: true };
const TRX_MESSAGE = { open: /<Message>/, close: () => "</Message>" };
const TRX_STACK = { open: /<StackTrace>/, close: () => "</StackTrace>" };
const TRX_COUNTERS_RE = /<Counters\b([^>]*?)\/?>/;

/** The failed results of a trx document, or none. */
function trx(s) {
  if (!TRX_DOC.test(s)) return [];
  const out = [];
  for (const result of elements(s, TRX_RESULT_RE, TRX_RESULT)) {
    const a = xmlAttributes(result[1]);
    if (a.outcome !== "Failed" || !a.testName || !result[2]) continue;
    const message = firstElement(result[2], TRX_MESSAGE_RE, TRX_MESSAGE);
    const stack = firstElement(result[2], TRX_STACK_RE, TRX_STACK);
    let file, line;
    for (const raw of xmlText(stack?.[1] ?? "").split("\n")) {
      const at = raw.match(AT_RE);
      if (at && !FRAMEWORK.test(at[1])) { file = at[2]; line = +at[3]; break; }
    }
    // The result element, from its opening tag to its closing one.
    out.push(withSource({
      file, line,
      title: shortName(a.testName), subject: shortName(a.testName), severity: "error",
      message: xmlText(message?.[1] ?? "").split("\n").map((l) => l.trim())
        .filter(Boolean).slice(0, MAX_MESSAGE_LINES).join("\n"),
    }, lineAt(s, result.index), lineAt(s, result.index + result[0].length - 1) + 1));
  }
  return out;
}

/** "Namespace.Class.Method" reads better as "Class.Method". */
function shortName(fq) {
  const parts = fq.split(".");
  return parts.length > 2 ? parts.slice(-2).join(".") : fq;
}

const rangedFailure = withSource;

function summaryNumber(text, key) {
  if (key === "total") {
    const tests = text.match(/^Total tests:[^\S\n]*(\d+)[^\S\n]*$/im);
    if (tests) return +tests[1];
  }
  const standalone = text.match(new RegExp(String.raw`^[^\S\n]*${key}:[^\S\n]*(\d+)[^\S\n]*$`, "im"));
  if (standalone) return +standalone[1];
  const compact = text.match(new RegExp(String.raw`\b${key}:[^\S\n]*(\d+)`, "i"));
  return compact ? +compact[1] : null;
}

function summary(text) {
  const [total, failed, ok, skipped] = ["total", "failed", "passed", "skipped"]
    .map((key) => summaryNumber(text, key));
  const bits = [];
  if (failed) bits.push(`${failed} failed`);
  if (ok) bits.push(`${ok} passed`);
  if (skipped) bits.push(`${skipped} skipped`);
  return bits.length ? `${bits.join(", ")}${total ? ` (${total})` : ""}` : undefined;
}

function vstest(text) {
  const tally = text.match(VSTEST_TALLY_RE);
  if (!VSTEST_END_RE.test(text) && !tally) return null;
  // The failure word in each run's own language, from each run's own tally. One log can
  // hold two runs in two languages - a CI matrix leg per locale - and learning the word
  // from the first tally only read the runs that happened to speak its language.
  const failWords = new Set(["Failed"]);
  for (const t of text.matchAll(new RegExp(VSTEST_TALLY_RE.source, "gm"))) failWords.add(t[1].trim());
  const failedRe = new RegExp(`^[^\\S\\n]+(?:${[...failWords].map(escapeRe).join("|")})[^\\S\\n]+(.+?)[^\\S\\n]+\\[(?:<[^\\S\\n]+)?\\d+(?:\\.\\d+)?[^\\S\\n]*(?:ms|s)\\][^\\S\\n]*$`);
  const lines = text.split("\n");
  const failures = [];
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i].match(failedRe) ?? lines[i].match(VSTEST_FAILED_RE);
    if (!head) continue;
    let end = i + 1;
    while (end < lines.length && !VSTEST_RESULT_RE.test(lines[end]) && !VSTEST_ANY_RESULT_RE.test(lines[end]) &&
      !VSTEST_TALLY_RE.test(lines[end]) &&
      !/^(?:Test Run (?:Failed|Successful)\.|Total tests:|Failed![^\n]*\bFailed:)/.test(lines[end])) end++;

    const message = [];
    let file, line, labels = 0;
    for (let j = i + 1; j < end; j++) {
      const frame = lines[j].match(AT_RE);
      if (frame) {
        if (!file && !FRAMEWORK.test(frame[1])) { file = frame[2]; line = +frame[3]; }
        continue;
      }
      const value = lines[j].trim();
      // The first label opens the message and the second opens the stack, in whatever
      // language the labels were written.
      if (VSTEST_LABEL_RE.test(lines[j])) { labels++; continue; }
      if (labels === 1 && value && message.length < MAX_MESSAGE_LINES) message.push(value);
    }
    failures.push(rangedFailure({
      file, line, title: shortName(head[1]), subject: shortName(head[1]), severity: "error",
      message: message.join("\n") || "test failed",
    }, i, end));
    i = end - 1;
  }
  const runs = (text.match(new RegExp(VSTEST_END_RE.source, "gm"))?.length ?? 0) ||
    (text.match(new RegExp(VSTEST_TALLY_RE.source, "gm"))?.length ?? 0);
  return failures.length ? { failures, summary: runs === 1 ? (summary(text) ?? tallied(tally)) : undefined } : null;
}

/** The counts of a tally in any language: failed, passed, skipped and total, in that order,
 *  which is the order all thirteen of the SDK's languages print them in. */
function tallied(tally) {
  if (!tally) return undefined;
  const [failed, passed, skipped, total] = (tally[0].slice(tally[1].length).match(/\d+/g) ?? []).map(Number);
  if (total === undefined) return undefined;
  const bits = [];
  if (failed) bits.push(`${failed} failed`);
  if (passed) bits.push(`${passed} passed`);
  if (skipped) bits.push(`${skipped} skipped`);
  return bits.length ? `${bits.join(", ")} (${total})` : undefined;
}

/** Whether `s` holds a Testing Platform run in a language other than English: a failure
 *  heading with its assembly line and a stack under it.
 *
 *  The English reading also asks for "Test run summary:". This does not ask for the
 *  translated summary, because a long log capped to its interesting lines keeps the
 *  failures and loses the counts under the summary - they are a label and a number, which
 *  is all a build prints - and the assembly line's `(net10.0|arm64)` is Testing
 *  Platform's alone already. What goes missing then is the summary, not the failures. */
function mtpTranslated(s) {
  if (!s.includes(".dll")) return false;
  const lines = s.split("\n");
  const words = mtpFailWords(lines);
  return words.size > 1 && lines.some((l) => mtpHead(l, words));
}

export default {
  name: "dotnet test",
  // Strings a log has to hold for this parser to read anything from it - see src/router.js.
  signals: ["Test run summary:", ".dll", "Test Run Failed.", "Failed!", "TeamTest"],
  category: "test",
  commands: ["dotnet"],
  detect: (s) => (MTP_FAILED_RE.test(s.split("\n").find((l) => MTP_FAILED_RE.test(l)) ?? "") &&
    /^[^\S\n]*Test run summary:/m.test(s)) || mtpTranslated(s) || !!vstest(s) || trx(s).length > 0,

  extract(s) {
    const vs = vstest(s);
    const lines = s.split("\n");
    const failures = [];

    const words = mtpFailWords(lines);
    for (let i = 0; i < lines.length; i++) {
      const head = mtpHead(lines[i], words);
      if (!head) continue;

      const msg = [];
      // The heading, down to the frame in your code or the last line of the message read
      // under it - not the rest of the log a last failure goes on scanning for frames.
      let file, line, repeated = false, end = i + 1;
      for (let j = i + 1; j < lines.length && !mtpHead(lines[j], words); j++) {
        const at = lines[j].match(AT_RE) ?? lines[j].match(MTP_FRAME_RE);
        if (at) {
          // the first frame in the user's own code wins; the rest is the runner
          if (!file && !FRAMEWORK.test(at[1])) { file = at[2]; line = +at[3]; end = j + 1; }
          continue;
        }
        // `from <dll>` closes the first copy of the message. Everything after it is
        // the same text re-indented, so stop collecting - but keep scanning, because
        // the stack frames that carry the location come after the repeat.
        if (/^[^\S\n]*from[^\S\n]+\S+\.dll/.test(lines[j]) || MTP_FROM_RE.test(lines[j])) { repeated = true; if (!file) end = j + 1; continue; }
        const t = lines[j].trim();
        if (repeated || !t || msg.length >= MAX_MESSAGE_LINES) continue;
        if (/^Standard output:/.test(t) || /^Test run summary:/.test(t) || /^Exit code:/.test(t)) break;
        msg.push(t);
        if (!file) end = j + 1;
      }

      failures.push(withSource({
        file, line,
        title: shortName(head[1]), subject: shortName(head[1]), severity: "error",
        message: msg.join("\n"),
      }, i, end));
    }

    // ...and the trx document, which a job keeps beside its console output rather than
    // instead of it. A result already read from the console is not read twice.
    const fromDocument = trx(s);
    if (fromDocument.length) {
      // ...though where it was read in the document is kept with it.
      const keyOf = (f) => [f.subject, f.file, f.line].join("\u0000");
      const said = new Map();
      for (const list of [vs?.failures ?? [], failures]) {
        list.forEach((f, index) => { if (!said.has(keyOf(f))) said.set(keyOf(f), { list, index }); });
      }
      const fresh = fromDocument.filter((f) => {
        const earlier = said.get(keyOf(f));
        if (earlier) earlier.list[earlier.index] = joinSources(earlier.list[earlier.index], f);
        return !earlier;
      });
      if (!failures.length && !vs) {
        const c = s.match(TRX_COUNTERS_RE);
        const counts = c ? xmlAttributes(c[1]) : {};
        const bits = [];
        for (const [key, word] of [["failed", "failed"], ["passed", "passed"]]) {
          if (+counts[key] > 0) bits.push(`${+counts[key]} ${word}`);
        }
        return {
          tool: "dotnet test",
          summary: bits.length ? `${bits.join(", ")}${+counts.total ? ` (${+counts.total})` : ""}` : undefined,
          failures: fromDocument,
        };
      }
      failures.push(...fresh);
    }

    if (!failures.length) {
      return vs ? { tool: "dotnet test", summary: vs.summary, failures: vs.failures } : null;
    }
    // CI may concatenate retries from different .NET test runners. Both encodings are
    // real runs; keep both failure sets and do not present either run's tally as if it
    // described their combination.
    if (vs) return { tool: "dotnet test", failures: [...vs.failures, ...failures] };

    // "total: 80 / failed: 3 / succeeded: 77" -> "3 failed, 77 passed (80)"
    const num = (k) => {
      const m = s.match(new RegExp(String.raw`^[^\S\n]*${k}:[^\S\n]*(\d+)[^\S\n]*$`, "m"));
      return m ? +m[1] : null;
    };
    // The labels are translated and their order is not, so the counts are read by
    // position - in English too. Reading the English labels first, and positions only
    // when none was found, lost the summary of a Spanish and a Portuguese run: both call
    // the first count "total", which matched, and nothing else did.
    const counts = s.match(MTP_TALLY_RE)?.[1].match(/\d+(?=[^\S\n]*\n)/g)?.map(Number);
    const [total, failed, ok, skipped] = counts ?? ["total", "failed", "succeeded", "skipped"].map(num);
    const bits = [];
    if (failed) bits.push(`${failed} failed`);
    if (ok) bits.push(`${ok} passed`);
    if (skipped) bits.push(`${skipped} skipped`);
    const summary = bits.length ? `${bits.join(", ")}${total ? ` (${total})` : ""}` : undefined;

    return { tool: "dotnet test", summary, failures };
  },
};
