import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fingerprint } from "./cluster.js";

// Comparing two runs is only meaningful when they asked the same question. A pytest
// run and a jest run share no vocabulary; `pytest tests/unit` and `pytest tests/api`
// do not even cover the same code, so a cause missing from the second is not a cause
// that was fixed. The identity below is therefore the whole invocation, and runs that
// differ in any part of it simply never meet.
const IDENTITY_VERSION = 1;

/** Where a run's fingerprints live. Never the project: whatbroke promises it writes
 *  nothing into your working directory, and a tool that quietly drops a state file
 *  next to your source has broken that promise however useful the feature is. */
export function cacheDir(env = process.env) {
  if (env.WHATBROKE_CACHE_DIR) return env.WHATBROKE_CACHE_DIR;
  if (process.platform === "win32") {
    return join(env.LOCALAPPDATA || env.APPDATA || tmpdir(), "whatbroke");
  }
  if (process.platform === "darwin") return join(homedir(), "Library", "Caches", "whatbroke");
  return join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "whatbroke");
}

/** A stable name for "this command, in this directory, reporting this tool". */
export function runIdentity({ cwd, tool, argv }) {
  return fingerprint(JSON.stringify([IDENTITY_VERSION, resolve(cwd), tool ?? "", argv ?? []]));
}

const fileFor = (identity) => join(cacheDir(), `${identity}.json`);

export function loadRun(identity) {
  try {
    const saved = JSON.parse(readFileSync(fileFor(identity), "utf8"));
    if (saved?.version !== IDENTITY_VERSION || !Array.isArray(saved.causes)) return null;
    return saved;
  } catch { return null; }
}

/** Write via a temporary file and rename, so an interrupted run leaves the previous
 *  state intact rather than a half-written file that reads as "nothing was failing". */
export function saveRun(identity, record) {
  const target = fileFor(identity);
  const temp = `${target}.${process.pid}.tmp`;
  try {
    mkdirSync(cacheDir(), { recursive: true });
    writeFileSync(temp, JSON.stringify({ version: IDENTITY_VERSION, ...record }));
    renameSync(temp, target);
    return true;
  } catch {
    try { unlinkSync(temp); } catch { /* nothing to clean up */ }
    return false;   // a cache that cannot be written must never fail the run
  }
}

/** What this run can honestly say about the last one.
 *
 *  `fresh` is a claim about presence and is always safe: this cause was not in the
 *  previous run's list. `gone` is a claim about ABSENCE, and absence is only evidence
 *  when the current run actually got far enough to speak. A truncated capture, a
 *  command that never started, or a run whose parser found nothing all produce an
 *  empty-ish list for reasons that have nothing to do with anything being fixed - so
 *  in those cases the count is withheld rather than guessed at. */
export function compare(previous, currentIds, { truncated = false, trustworthy = true } = {}) {
  if (!previous) return { compared: false, reason: "no-previous-run", fresh: [], gone: null };
  const before = new Set(previous.causes);
  const fresh = currentIds.filter((id) => !before.has(id));
  const gone = truncated ? null
    : !trustworthy ? null
    : previous.causes.filter((id) => !currentIds.includes(id)).length;
  return {
    compared: true,
    reason: null,
    fresh,
    gone,
    ranAt: previous.ranAt ?? null,
    goneWithheld: gone === null ? (truncated ? "truncated" : "run-not-comparable") : null,
  };
}
