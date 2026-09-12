import { xmlAttributes, xmlText } from "../util.js";
const LOCATION_RE = /^[^\S\n]*(.+?):(\d+)$/;
// PHPUnit separates an assertion that did not hold ("failure") from an exception that
// escaped ("error") and heads each block differently. Reading only the first meant an
// uncaught exception - at least as common as a failed assertion - fell through.
const TALLY_RE = /There (?:was|were) \d+ (?:failure|error)/;
// A file that throws while being loaded never becomes a numbered result at all.
const INTERNAL_RE = /^An error occurred inside PHPUnit\.$/m;

// --log-junit writes the same results as a JUnit document, which is a shape every runner
// writes. What makes a result PHPUnit's is inside the element: PHPUnit opens the body
// with the test it belongs to, written `Class::method` - the same name its console
// output gives the block - so a result is read only when that line matches the case's
// own class and name. The document was not read at all before.
const CASE_RE = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
const OUTCOME_RE = /<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/;

// --testdox prints the same run with the class and the test renamed into prose, grouped
// under the class, with every line of the body behind a box-drawing rule. The renaming
// is the point of the format, so the names it gives are the names reported - but the
// location and the message are the same ones the console output gives.
const TESTDOX_GROUP = /^(\S.*?)[^\S\n]*$/;
const TESTDOX_TEST = /^[^\S\n]+[✘✗][^\S\n]+(\S.*?)[^\S\n]*$/;
const TESTDOX_BODY = /^[^\S\n]*│[^\S\n]?(.*)$/;
const TESTDOX_ANY = /^[^\S\n]+[✘✗][^\S\n]+\S/m;

/** The location a PHPUnit body ends with, and the message above it. */
function bodyOf(text) {
  let file, line;
  const message = [];
  for (const raw of text.split("\n")) {
    const location = raw.trim().match(LOCATION_RE);
    if (location && /\.[a-z]+$/i.test(location[1])) { file = location[1]; line = +location[2]; continue; }
    if (raw.trim()) message.push(raw.trim());
  }
  return { file, line, message: message.join("\n") };
}

/** The results of a `--log-junit` document, or none. */
function junitResults(s) {
  if (!s.includes("<testcase")) return [];
  const out = [];
  for (const test of s.matchAll(CASE_RE)) {
    if (!test[2]) continue;
    const a = xmlAttributes(test[1]);
    const outcome = test[2].match(OUTCOME_RE);
    if (!outcome || !outcome[3]) continue;
    const text = xmlText(outcome[3]);
    const name = `${a.class ?? a.classname ?? ""}::${a.name ?? ""}`;
    // The body's first line is PHPUnit naming the test. If it is not this test, this is
    // some other runner's document and none of it is PHPUnit's to read.
    const [first, ...rest] = text.split("\n");
    if (first.trim() !== name) continue;
    const body = bodyOf(rest.join("\n"));
    out.push({
      file: body.file ?? a.file, line: body.line ?? (+a.line || undefined),
      title: name, subject: name, severity: "error", message: body.message,
    });
  }
  return out;
}

/** The results of a `--testdox` run, or none. */
function testdoxResults(s) {
  const lines = s.split("\n");
  const out = [];
  let group = null;
  for (let i = 0; i < lines.length; i++) {
    const test = lines[i].match(TESTDOX_TEST);
    if (!test) {
      // A heading is a line of its own at column zero, and PHPUnit's own banners and
      // tallies are not headings.
      const g = lines[i].match(TESTDOX_GROUP);
      if (g && !/^(?:PHPUnit|Runtime|Time:|Tests:|OK\b|FAILURES!|ERRORS!|WARNINGS!)/.test(g[1])) group = g[1];
      continue;
    }
    const body = [];
    for (let j = i + 1; j < lines.length; j++) {
      const b = lines[j].match(TESTDOX_BODY);
      if (!b) break;
      body.push(b[1]);
    }
    if (!body.length) continue;
    const read = bodyOf(body.join("\n"));
    out.push({
      ...read, title: group ? `${group} › ${test[1]}` : test[1],
      subject: group ? `${group} › ${test[1]}` : test[1], severity: "error",
    });
  }
  return out;
}

export default {
  name: "phpunit",
  category: "test",
  commands: ["phpunit"],
  detect: (s) =>
    (TALLY_RE.test(s) && /^\d+\)[^\S\n]+[\w\\]+::\w+/m.test(s)) ||
    (INTERNAL_RE.test(s) && /^Location:[^\S\n]+\S+:\d+$/m.test(s)) ||
    junitResults(s).length > 0 ||
    (TESTDOX_ANY.test(s) && /^Tests:[^\S\n]+\d/m.test(s)),

  extract(s) {
    const lines = s.split("\n");
    const failures = [];

    // PHPUnit erroring inside itself used to end the read. One run that does that has no
    // test results to report, so there was nothing else to find - but a log holding more
    // than one run does, and returning early dropped the other run's failures silently.
    const internal = [];
    if (INTERNAL_RE.test(s)) {
      const message = s.match(/^Message:[^\S\n]+(.+)$/m);
      const at = s.match(/^Location:[^\S\n]+(.+?):(\d+)$/m);
      if (message || at) {
        internal.push({
          file: at?.[1], line: at ? +at[2] : undefined,
          title: "load error", label: "load error", severity: "error",
          message: message?.[1] ?? "An error occurred inside PHPUnit.",
        });
      }
    }
    // PHPUnit's numbered blocks live under "There were N failures:" and nowhere else.
    // "N) name" belongs to jasmine, mocha, rspec and Playwright too, and jasmine writes
    // its own at column zero exactly as PHPUnit does - so scanning the whole log claimed
    // jasmine's failures as PHPUnit's whenever both were in it.
    // One log can hold more than one PHPUnit run - a testsuite at a time, or a package
    // at a time across a monorepo - and each announces its own blocks. Reading only the
    // first announcement stopped at that run's section and dropped the rest.
    const announcements = lines.flatMap((l, i) => (TALLY_RE.test(l) ? [i] : []));
    // ...and they end where PHPUnit's run does. Without that bound a log with PHPUnit
    // first read whatever numbered blocks came after it as more of its own. The inner
    // loop already stopped there; the outer one did not.
    const END_RE = /^[^\S\n]*(?:Tests:|OK\b|FAILURES!|ERRORS!|WARNINGS!)/;
    // No announcement, no blocks. This was true before only by accident: a log without
    // the tally was a log that had errored inside PHPUnit, and that returned early
    // before ever reaching here. Letting it reach here started the scan at line 0 and
    // read jasmine's numbered blocks as PHPUnit's - 5 failures where the two logs hold
    // 3 - which is the same claim the bound above exists to prevent.
    for (const announced of announcements) {
    for (let i = announced + 1; i < lines.length && !END_RE.test(lines[i]); i++) {
      const header = lines[i].match(/^\d+\)[^\S\n]+(.+)$/);
      if (!header) continue;
      const message = [];
      let file;
      let line;
      // A block ends at the next numbered block, at the run's own closing lines - and
      // at the rule PHPUnit draws between its sections. Without that last one the errors
      // section ran into the failures section, and the error carried "--" and
      // "There were 2 failures:" along as part of its message.
      for (let j = i + 1; j < lines.length &&
        !/^\d+\)[^\S\n]+/.test(lines[j]) &&
        !/^[^\S\n]*--[^\S\n]*$/.test(lines[j]) &&
        !TALLY_RE.test(lines[j]) &&
        !/^[^\S\n]*(?:Tests:|Time:|OK\b|FAILURES!|ERRORS!|WARNINGS!)/.test(lines[j]); j++) {
        const location = lines[j].match(LOCATION_RE);
        if (location && /\.[a-z]+$/i.test(location[1])) {
          file = location[1];
          line = +location[2];
        } else if (lines[j].trim()) {
          message.push(lines[j].trim());
        }
      }
      failures.push({ file, line, title: header[1], subject: header[1], severity: "error", message: message.join("\n") });
    }
    }
    // ...and the same run as one of PHPUnit's other outputs wrote it. A result already
    // read from the console blocks is not read twice.
    const said = new Set(failures.map((f) => [f.subject, f.file, f.line].join("\u0000")));
    // Every output is read, not just the one that fills in for the others. --testdox
    // replaces the standard printer rather than joining it, so a log holding both is a
    // log holding two runs - and reading testdox only when nothing else was found lost
    // the second one whole.
    const other = [...junitResults(s), ...testdoxResults(s)];
    for (const f of other) {
      const key = [f.subject, f.file, f.line].join("\u0000");
      if (said.has(key)) continue;
      said.add(key);
      failures.push(f);
    }

    if (!failures.length && !internal.length) return null;
    // PHPUnit's tally names failures and errors separately, and reporting only the
    // failures said "0 failures" over a run that errored.
    const tally = s.match(/^Tests:[^\S\n]+(.+?)\.?$/m);
    const counted = [];
    for (const kind of ["Failures", "Errors"]) {
      const m = tally?.[1].match(new RegExp(`${kind}:[^\\S\\n]*(\\d+)`));
      const n = Number(m?.[1] ?? 0);
      if (n) counted.push(`${n} ${kind.toLowerCase().replace(/s$/, "")}${n > 1 ? "s" : ""}`);
    }
    if (internal.length) {
      // The internal error is why PHPUnit stopped, so it leads; whatever else the log
      // holds follows it rather than being dropped.
      const rest = counted.length ? counted.join(", ") : failures.length ? `${failures.length} failures` : "";
      return {
        tool: "phpunit",
        summary: rest ? `error inside PHPUnit — ${rest} elsewhere` : "error inside PHPUnit",
        failures: [...internal, ...failures],
      };
    }
    // Every console format prints the tally. A --log-junit document on its own prints
    // none - but it counts the same things on its outermost suite, so the sentence is
    // written from there rather than from how many results happened to be read.
    if (!counted.length) {
      const root = s.match(/<testsuite\b([^>]*)>/);
      const a = root ? xmlAttributes(root[1]) : {};
      for (const kind of ["failures", "errors"]) {
        const n = Number(a[kind] ?? 0);
        if (n) counted.push(`${n} ${kind.replace(/s$/, "")}${n > 1 ? "s" : ""}`);
      }
    }
    return {
      tool: "phpunit",
      summary: counted.length ? counted.join(", ") : `${failures.length} failures`,
      failures,
    };
  },
};
