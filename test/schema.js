// A JSON Schema validator for the one schema whatbroke publishes, and no more.
//
// whatbroke has no dependencies and its tests take none either, so this implements only
// the keywords report.schema.json uses, with draft 2020-12's meaning. A validator that
// meets a keyword it does not know skips it, and then passes everything the keyword was
// written to refuse - so `unknownKeywords` lists any the schema uses that are not here,
// and test/report.js requires that list to be empty.
import { readFileSync } from "node:fs";

export const REPORT_SCHEMA = JSON.parse(readFileSync(new URL("../report.schema.json", import.meta.url), "utf8"));

// Keywords that say something about a value. The rest are notes for a reader.
const ASSERTIONS = new Set(["$ref", "type", "const", "enum", "anyOf", "properties", "required",
  "items", "minItems", "minLength", "pattern", "minimum"]);
const ANNOTATIONS = new Set(["$schema", "$id", "$defs", "title", "description"]);

const typeOf = (v) => v === null ? "null" : Array.isArray(v) ? "array"
  : Number.isInteger(v) ? "integer" : typeof v;
const hasType = (v, type) => typeOf(v) === type || (type === "number" && typeof v === "number" && Number.isFinite(v));
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Every keyword the schema uses that this validator would silently skip. */
export function unknownKeywords(schema) {
  const unknown = new Set();
  const walk = (s) => {
    for (const [key, value] of Object.entries(s)) {
      if (!ASSERTIONS.has(key) && !ANNOTATIONS.has(key)) unknown.add(key);
      if (key === "properties" || key === "$defs") Object.values(value).forEach(walk);
      if (key === "items") walk(value);
      if (key === "anyOf") value.forEach(walk);
    }
  };
  walk(schema);
  return [...unknown];
}

function resolve(root, ref) {
  if (!ref.startsWith("#/")) throw new Error(`only references inside the schema are supported, not ${ref}`);
  return ref.slice(2).split("/").reduce((node, key) => {
    const next = node?.[key.replace(/~1/g, "/").replace(/~0/g, "~")];
    if (next === undefined) throw new Error(`${ref} does not resolve`);
    return next;
  }, root);
}

/** Every way `value` breaks `schema`, as "path: what is wrong".
 *
 *  `strict` also refuses a property that an object's schema does not list. The published
 *  schema allows one, since version 1 may gain fields - but a field whatbroke itself
 *  writes and nothing documents is exactly what the tests are for. */
export function validate(value, schema = REPORT_SCHEMA, { strict = false } = {}) {
  const at = (path) => path || "/";
  const check = (v, s, path) => {
    const errors = [];
    if (s.$ref !== undefined) errors.push(...check(v, resolve(schema, s.$ref), path));
    if (s.type !== undefined) {
      const types = [].concat(s.type);
      if (!types.some((type) => hasType(v, type))) {
        return [...errors, `${at(path)}: expected ${types.join(" or ")}, found ${typeOf(v)}`];
      }
    }
    if (s.const !== undefined && !equal(v, s.const)) errors.push(`${at(path)}: must be ${JSON.stringify(s.const)}`);
    if (s.enum !== undefined && !s.enum.some((option) => equal(v, option))) {
      errors.push(`${at(path)}: ${JSON.stringify(v)} is not one of ${JSON.stringify(s.enum)}`);
    }
    if (s.anyOf !== undefined) {
      const tried = s.anyOf.map((option) => check(v, option, path));
      if (!tried.some((e) => e.length === 0)) errors.push(...tried.flat());
    }
    if (typeof v === "string") {
      if (s.minLength !== undefined && [...v].length < s.minLength) errors.push(`${at(path)}: shorter than ${s.minLength}`);
      if (s.pattern !== undefined && !new RegExp(s.pattern, "u").test(v)) errors.push(`${at(path)}: does not match ${s.pattern}`);
    }
    if (typeof v === "number" && s.minimum !== undefined && v < s.minimum) {
      errors.push(`${at(path)}: ${v} is less than ${s.minimum}`);
    }
    if (Array.isArray(v)) {
      if (s.minItems !== undefined && v.length < s.minItems) errors.push(`${at(path)}: fewer than ${s.minItems} items`);
      if (s.items !== undefined) v.forEach((item, i) => errors.push(...check(item, s.items, `${path}/${i}`)));
    }
    if (typeOf(v) === "object") {
      for (const key of s.required ?? []) {
        if (!Object.hasOwn(v, key)) errors.push(`${at(path)}: missing ${key}`);
      }
      for (const [key, item] of Object.entries(v)) {
        if (s.properties && Object.hasOwn(s.properties, key)) errors.push(...check(item, s.properties[key], `${path}/${key}`));
        else if (strict && s.properties) errors.push(`${at(path)}: ${key} is not in the schema`);
      }
    }
    return errors;
  };
  return check(value, schema, "");
}

/** What a report says about itself that a schema cannot: that its groups hold its own
 *  failures, that its exit codes agree, that nothing was read and yet reported. Returns
 *  every way `report` contradicts itself. */
export function inconsistencies(report) {
  const wrong = [];
  const read = report.tool !== null;
  if (!read) {
    if (report.failures.length) wrong.push("failures with no tool");
    for (const field of ["summary", "clusters", "others"]) {
      if (report[field] !== null) wrong.push(`${field} with no tool`);
    }
    if (report.guessed) wrong.push("guessed with no tool");
    if (report.wrappers.length) wrong.push("wrappers with no tool");
  } else {
    if (!report.failures.length) wrong.push("a tool with no failures");
    if (report.fallback !== null) wrong.push("a fallback beside a reading");
  }
  const commandExitCode = report.inputMode === "command" && report.error === null ? report.exitCode : null;
  if (report.commandExitCode !== commandExitCode) wrong.push(`commandExitCode ${report.commandExitCode}, not ${commandExitCode}`);
  if (report.error !== null && report.fallback?.reason !== "spawn-error") wrong.push("an error without a spawn-error fallback");
  const groups = [["", report], ...(report.others ?? []).map((other, i) => [`others/${i}/`, other])];
  for (const [path, group] of groups) {
    const n = group.failures.length;
    for (const [i, f] of group.failures.entries()) {
      if (f.tool !== group.tool) wrong.push(`${path}failures/${i} is ${f.tool}'s in ${group.tool}'s list`);
      // a warning is never reported as a failure
      if (f.severity !== "error") wrong.push(`${path}failures/${i} is a ${f.severity}`);
      if (f.col !== undefined && f.line === undefined) wrong.push(`${path}failures/${i} has a column and no line`);
    }
    if (group !== report && group.count !== n) wrong.push(`${path}count ${group.count} for ${n} failures`);
    if (group.clusters === null) continue;
    const seen = new Array(n).fill(0);
    for (const [c, cluster] of group.clusters.entries()) {
      if (cluster.size !== cluster.members.length) wrong.push(`${path}clusters/${c} has size ${cluster.size} for ${cluster.members.length} members`);
      if (!cluster.members.includes(cluster.exemplar)) wrong.push(`${path}clusters/${c} shows a failure that is not a member`);
      if (!cluster.reported && cluster.size !== 1) wrong.push(`${path}clusters/${c} groups ${cluster.size} without claiming a cause`);
      for (const m of cluster.members) {
        if (m >= n) wrong.push(`${path}clusters/${c} names failure ${m} of ${n}`);
        else seen[m]++;
      }
    }
    const unplaced = seen.flatMap((count, i) => (count === 1 ? [] : [`${i} (${count} times)`]));
    if (unplaced.length) wrong.push(`${path}clusters do not hold every failure once: ${unplaced.slice(0, 3).join(", ")}`);
  }
  return wrong;
}
