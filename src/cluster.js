// Group failures that share a likely root cause.
//
// The governing rule: over-splitting is cheap, over-merging is fatal. Splitting one
// cause into two costs the reader one extra block. Merging two causes into one makes
// them fix the exemplar, rerun, and watch the rest still fail - after which they stop
// believing the "likely cause" line anywhere. This tool never invents anything, and a
// wrong merge is an invention. Every rule below is tuned toward refusing to group.

import { createHash } from "node:crypto";

export const MIN_CLUSTER = 3;   // two failures sharing a shape is usually coincidence
export const MIN_CONTENT = 2;   // a signature of one word is a shape, not a bug

// Quoted content that is short and has no whitespace is a NAME - unquote and keep it,
// so KeyError: 'exp' stays distinct from KeyError: 'sub'. Anything else is DATA.
// The lookbehind matters: without it the apostrophe in "doesn't" opens a match that
// swallows the rest of the line.
const QUOTED = /(?<![A-Za-z0-9_])'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\\n]|\\.)*`/g;
const NAME_MAX = 32;

const SRC_EXT = "js|jsx|mjs|cjs|ts|tsx|py|pyi|rs|go|java|kt|kts|rb|php|c|cc|cpp|cxx|h|hh|hpp|m|mm|cs|swift|scala|sh|sql|json|ya?ml|toml|lock";

// What a resolver could not find is the OPERAND of the failure, not an incidental place
// in it. Step 3 turned "Cannot find module './a.js'" into "Cannot find module <path>", so
// three different missing modules became one "likely cause" - the reader adds one
// dependency, reruns, and watches the other two fail. These phrases name the thing that is
// missing, and whatever follows them is held out of the path rules and put back after.
const MISSING_OPERAND = /\b(?:(?:cannot|could not|can't|couldn't|unable to)[^\S\n]+(?:find|resolve|locate|load)(?:[^\S\n]+(?:module|package|crate|dependency|declaration file for module))?|no[^\S\n]+module[^\S\n]+named|unresolved[^\S\n]+import|module[^\S\n]+not[^\S\n]+found:?(?:[^\S\n]+Error:)?(?:[^\S\n]+Can't[^\S\n]+resolve)?|failed[^\S\n]+to[^\S\n]+resolve)[^\S\n]*:?[^\S\n]+(?!in\b|from\b)([^\s,;]+)/gi;
// Letters then digits: no word boundary sits between "F" and "0", so steps 4 and 5 - which
// all begin with \b - cannot see a number here and the marker survives them intact.
const HELD = (n) => `MODULEREF${n}`;

/** Reduce a message to its shape, keeping the parts that identify WHICH bug it is.
 *  Rule order is load-bearing; each step assumes the previous ones have run. */
export function skeleton(text) {
  // Quoting nests: tsc writes `'["**/*"]'`, and one pass unwraps the outer layer while
  // leaving the inner one to be recognised on the next. A fingerprint has to be a
  // canonical form or two spellings of the same message never meet, so reduce to a
  // fixed point. Bounded, because a fingerprint is not a place to loop indefinitely.
  let out = reduce(text);
  for (let pass = 0; pass < 2; pass++) {
    const next = reduce(out);
    if (next === out) break;
    out = next;
  }
  return out;
}

function reduce(text) {
  let s = String(text ?? "").slice(0, 1000);
  s = s.replace(/\s+/g, " ").trim();
  const held = [];

  // 1. quoted values, before anything that could chew their insides
  s = s.replace(QUOTED, (m) => {
    const inner = m.slice(1, -1);
    return inner.length <= NAME_MAX && !/\s/.test(inner) ? inner : "<str>";
  });

  // 2. urls before paths, or the // in https:// counts as separators
  s = s.replace(/\b[a-z][\w+.-]*:\/\/\S+/gi, "<url>");

  // 2b. hold aside what a resolver said it could not find, before the path rules run
  s = s.replace(MISSING_OPERAND, (whole, operand) =>
    whole.slice(0, whole.length - operand.length) + HELD(held.push(operand) - 1));

  // 3. paths must PROVE themselves - a drive prefix, two separators, or a known source
  //    extension. Otherwise "cart.total" and "result.output" get eaten.
  s = s.replace(/\b[A-Za-z]:[\\/][^\s'"]+/g, "<path>")
       .replace(/(?:[\w.@+~-]+)?(?:[/\\][\w.@+~-]+){2,}/g, "<path>")
       // take a leading separator with it, or "/route.json" normalises to "/<path>"
       // while "/foo/bar" normalises to "<path>" and the two never cluster
       .replace(new RegExp(String.raw`(?:[/\\])?\b[\w.@+-]+\.(?:${SRC_EXT})\b`, "g"), "<path>");

  // 4. machine identifiers, before numbers. The lookahead on <hex> requires a digit so
  //    it cannot eat English words spelled only with a-f ("defaced").
  s = s.replace(/\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g, "<uuid>")
       .replace(/\b0[xX][0-9a-fA-F]+\b/g, "<addr>")
       .replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{7,}\b/g, "<hex>");

  // 5. numbers. \b on both sides is what keeps TS2551, E0308, i64, utf8 intact.
  s = s.replace(/\b\d+(?:\.\d+)?\b/g, "<num>");
  s = s.replace(/<num>(?:\s*,\s*<num>)+/g, "<num>*");

  // and put it back, so two runs that lost the same module still meet and two that lost
  // different ones never do.
  if (held.length) s = s.replace(/MODULEREF(\d+)/g, (m, n) => held[+n] ?? m);

  return s.replace(/\s+/g, " ").trim().slice(0, 512);
}

/** Trailing bracket group only, and only for the DISPLAY label. Applying this to
 *  messages would destroy list[int], [OPTIONS] and [-Wint-conversion]. */
export const normTitle = (t) => String(t ?? "").replace(/\[[^\]]*\]\s*$/, "[…]").trim();

/** What identifies a failure, as opposed to where it happened.
 *
 *  This used to be a table mapping each of 27 tool strings to what its `title` meant,
 *  because `title` held a diagnostic code for a linter and a test name for a runner and
 *  no heuristic tells "no-unused-vars" from "test_invoice_total". Parsers now say which
 *  they produced, so the policy falls out of the failure itself:
 *
 *  - `code` is the identity. Keep it, and drop the echoed source line: for a compiler
 *    the statement is the INSTANCE, and the same lint in forty places is one thing.
 *  - `subject` is the site - the axis being clustered across - so it never enters the
 *    key, and the failing expression stays as the strongest discriminator there is.
 *  - `label` is a constant the tool prints for a whole class of failure. Harmless in
 *    the key, and dropping it would cost the signature words it is scored on.
 *
 *  A failure declaring none of them clusters on its message alone, which is the same
 *  inert behaviour an unknown tool used to get. */
const part = (f) => [
  String(f.code ?? f.label ?? ""),
  skeleton(f.message),
  // The echoed source line is the INSTANCE for any compiler, whether or not the tool
  // handed out a diagnostic code to say so. Keying on `code` alone got clang right by
  // accident - it sets no stmt - and swift wrong: eight identical "cannot convert value
  // of type 'String'" errors differed only by "let v1 = ..." / "let v2 = ..." and were
  // listed one by one, four of them behind a "... 4 more".
  f.code || f.category === "compile" ? "" : skeleton(f.stmt),
];

export const keyOf = (f) => JSON.stringify(part(f));
export const signatureOf = (f) => part(f).filter(Boolean).join("  ·  ");

/** Whether a signature carries too little to group two failures on. The display already
 *  refuses these; `causeId` asks the same question so history refuses them too. */
export const tooWeakToGroup = (f) => contentScore(signatureOf(f)) < MIN_CONTENT;

const PLACEHOLDER = /<(?:str|num|path|url|hex|uuid|addr)>\*?/g;
// Node's assertion header describes the matcher, not the bug. After numeric
// values disappear, it must not turn an otherwise empty signature into evidence.
// Keep the header in the fingerprint; discount it only when scoring information.
const ASSERTION_BOILERPLATE = /\bAssertionError(?: \[ERR_ASSERTION\])?: Expected values (?:not )?to be (?:(?:strictly|loosely) )?(?:deep-)?equal:\s*/g;

/** How much real content a signature carries. "assert <num> == <num>" scores 1 and is
 *  refused: forty unrelated numeric assertions must not become one "likely cause". */
export function contentScore(sig) {
  const words = sig.replace(ASSERTION_BOILERPLATE, " ").replace(PLACEHOLDER, " ")
    .match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  return new Set(words).size;
}

/** A cause's identity ACROSS runs.
 *
 *  Deliberately not a cluster's own `id`: an unreported cluster mixes its member
 *  index into that id, so the same lone failure is named differently the moment
 *  another failure appears before it. The content key is what identifies the bug.
 *
 *  Nor is it the display's key. "assert <num> == <num>" is one word once the numbers are
 *  gone, and the display refuses to group on that - but history went on treating every
 *  numeric assertion in a suite as one cause, so a second test failing reported "nothing
 *  new" and a first test fixed reported nothing gone. Where the signature is too weak to
 *  group on, the subject decides instead: it is what tells two such failures apart, and
 *  unlike a file or a line it survives the code being moved. */
export function historyKeyOf(failure) {
  const key = keyOf(failure);
  if (!tooWeakToGroup(failure)) return key;
  return JSON.stringify([key, String(failure.subject ?? failure.title ?? "")]);
}

export const causeId = (failure) => fingerprint(historyKeyOf(failure));

export function fingerprint(key) {
  return createHash("sha256").update(String(key)).digest("hex").slice(0, 24);
}

/** The pre-0.4 identity, kept only so one saved --since-last run can migrate without
 *  declaring every unchanged cause new. New output must never use this 32-bit hash. */
export function legacyFingerprint(key) {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Partition failures by shared cause. Every failure appears in exactly one cluster,
 *  including singletons, so consumers never have to reconcile two lists. */
export function clusterFailures(failures) {
  const buckets = new Map();
  failures.forEach((f, i) => {
    const key = keyOf(f);
    const at = buckets.get(key);
    if (at) at.push(i); else buckets.set(key, [i]);
  });

  const clusters = [];
  for (const [key, members] of buckets) {
    const sig = signatureOf(failures[members[0]]);
    // prefer an exemplar that can actually show source
    const located = members.find((i) => failures[i].file && failures[i].line);
    const reported = members.length >= MIN_CLUSTER && contentScore(sig) >= MIN_CONTENT;
    if (reported) {
      clusters.push({ id: fingerprint(key), signature: sig, size: members.length, members, exemplar: located ?? members[0], reported: true });
    } else {
      // refused: emit each member as its own unit so nothing is hidden behind a
      // grouping we were not confident enough to claim
      for (const i of members) {
        clusters.push({ id: fingerprint(key + ":" + i), signature: sig, size: 1, members: [i], exemplar: i, reported: false });
      }
    }
  }

  // reported first (largest first), then everything in document order. Sorting by size
  // alone would promote an unreported pair and silently reorder today's output.
  return clusters.sort((a, b) =>
    (b.reported - a.reported) || (b.reported && b.size - a.size) || (a.exemplar - b.exemplar));
}
