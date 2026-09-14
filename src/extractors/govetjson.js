import { jsonDocuments, jsonDocumentsAt } from "../util.js";
import { joinSources, withSource } from "../ownership.js";
// `go vet -json` writes its findings as documents rather than as lines:
//
//   {
//   	"example.com/shop/shop": {
//   		"printf": [
//   			{
//   				"posn": "/src/shop/cart.go:7:14",
//   				"end": "/src/shop/cart.go:7:16",
//   				"message": "fmt.Printf format %d has arg name of wrong type string"
//   			}
//   		]
//   	}
//   }
//   { ... the next package ... }
//
// Nothing read it. And it is one document PER PACKAGE, concatenated with nothing
// between them, so reading the first one and stopping would report one package's
// findings and silently drop the rest of the run.
//
// What the plain text form cannot say, this can: which analyzer spoke. `go vet` without
// -json writes `file:line:col: message`, which is exactly a compile error's shape, and
// nothing in the line says a vet analyzer produced it. Here the analyzer names itself,
// so the finding carries `printf` or `copylocks` as its code.
const POSN_RE = /^(.*):(\d+):(\d+)$/;

/** Every finding in the document, grouped by package and then by analyzer - each where
 *  its own object was written. */
function findings({ value: doc, where }) {
  const out = [];
  for (const byAnalyzer of Object.values(doc)) {
    for (const [analyzer, list] of Object.entries(byAnalyzer)) {
      for (const d of list) {
        const at = d.posn.match(POSN_RE);
        const { start, end } = where(d);
        out.push(withSource({
          file: at[1], line: +at[2], col: +at[3],
          title: analyzer, code: analyzer, category: "lint", severity: "error",
          message: String(d.message).trim(),
        }, start, end));
      }
    }
  }
  return out;
}

// A package path maps to a map of analyzer names, each holding a list of findings that
// carry a position and a message. An empty document is a package go vet had nothing to
// say about, and says nothing about whether this is go vet's output - so at least one
// finding has to be there before the shape is claimed.
const REPORT = (v) => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  let found = 0;
  for (const byAnalyzer of Object.values(v)) {
    if (!byAnalyzer || typeof byAnalyzer !== "object" || Array.isArray(byAnalyzer)) return false;
    for (const list of Object.values(byAnalyzer)) {
      if (!Array.isArray(list)) return false;
      for (const d of list) {
        if (!d || typeof d.posn !== "string" || typeof d.message !== "string") return false;
        if (!POSN_RE.test(d.posn)) return false;
        found++;
      }
    }
  }
  return found > 0;
};

const reports = (s) => s.includes('"posn"') ? [...jsonDocuments(s, REPORT)] : [];

export default {
  name: "go vet json",
  category: "lint",
  commands: ["go"],

  detect: (s) => reports(s).length > 0,

  extract(s) {
    const failures = [];
    const seen = new Map();
    for (const doc of s.includes('"posn"') ? jsonDocumentsAt(s, REPORT) : []) {
      for (const f of findings(doc)) {
        // A package can be listed under more than one module path in one run - and the
        // finding was read under each.
        const key = [f.file, f.line, f.col, f.code].join("\u0000");
        if (seen.has(key)) { failures[seen.get(key)] = joinSources(failures[seen.get(key)], f); continue; }
        seen.set(key, failures.length);
        failures.push(f);
      }
    }
    if (!failures.length) return null;
    const n = failures.length;
    const analyzers = [...new Set(failures.map((f) => f.code))];
    return {
      tool: "go vet",
      summary: `${n} problem${n === 1 ? "" : "s"} found by ${analyzers.join(", ")}`,
      failures,
    };
  },
};
