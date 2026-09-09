import { relPath } from "./util.js";
import { snippet, contextFor } from "./snippet.js";
import { normTitle, causeId } from "./cluster.js";

// A failure message line longer than this is padding - pytest lists every
// available fixture, rustc lists every trait impl. Keep the head, drop the rest.
const MAX_MESSAGE_LINE = 200;
const clip = (t) => t.length > MAX_MESSAGE_LINE
  ? t.slice(0, MAX_MESSAGE_LINE - 1).replace(/\s+\S*$/, "") + "\u2026"
  : t;

/** Tools print the source line they saw. If the file on disk no longer matches,
 *  it changed since the command ran and showing it would be a lie. */
function stale(file, line, toolText) {
  if (!toolText) return false;
  const one = snippet(file, line, 0);
  if (!one) return false;
  const disk = one[0].text.trim().replace(/\s+/g, " ");
  const tool = toolText.trim().replace(/\s+/g, " ").replace(/[…]+$/, "");
  if (!tool) return false;
  return !(disk === tool || disk.startsWith(tool) || tool.startsWith(disk));
}

const E = String.fromCharCode(27);
let C = {};
export function setColor(on) {
  const c = (code) => (on ? `${E}[${code}m` : "");
  C = {
    reset: c(0), dim: c(2), bold: c(1),
    red: c(31), green: c(32), yellow: c(33), blue: c(34), cyan: c(36), grey: c(90),
  };
}
setColor(false);

const pad = (n, w) => String(n).padStart(w);

// A generated bundle is one line megabytes wide, and the column a tool reports can
// sit deep inside it. Slide a fixed window across the snippet - the SAME offset for
// every line, so they stay aligned with each other - centred on the column when it
// would otherwise fall outside. The caret moves with the window: one parked a
// hundred thousand spaces past the text it marks points at nothing.
const SOURCE_WIDTH = 200;

/** Where the window starts, chosen from the line the caret is on. */
function windowStart(text, col) {
  const target = col ? col - 1 : 0;
  if (text.length <= SOURCE_WIDTH && target < SOURCE_WIDTH) return 0;
  if (target < SOURCE_WIDTH) return 0;                 // still reachable from the head
  return Math.max(0, Math.min(target - Math.floor(SOURCE_WIDTH / 2), text.length - SOURCE_WIDTH));
}

/** One line sliced to the window, with an ellipsis on each end that was cut. */
function windowed(text, start) {
  if (start === 0 && text.length <= SOURCE_WIDTH) return text;
  const head = start > 0 ? "…" : "";
  return head + text.slice(start, start + SOURCE_WIDTH) +
    (start + SOURCE_WIDTH < text.length ? "…" : "");
}

/** The caret's column after the window has moved under it. */
const windowedCol = (col, start) =>
  Math.max(1, Math.min(col - start + (start > 0 ? 1 : 0), SOURCE_WIDTH + 1));

const SITES_SHOWN = 3;   // how many extra sites to name before "+ N more"

export function render(result, { max = 5, cwd = true, source = true, cluster = true, since = null, secondary = false } = {}) {
  const out = [];
  const fails = result.failures;
  let lastSnip = null;   // don't reprint the same source region twice in a row

  // A unit is a cluster when we are confident enough to claim one, otherwise a single
  // failure. With nothing reported this is exactly the old failure list, in order, so
  // the output is byte-identical to before clustering existed.
  const units = (cluster && result.clusters)
    ? result.clusters
    : fails.map((_, i) => ({ size: 1, members: [i], exemplar: i, reported: false }));
  const reported = units.filter((u) => u.reported);

  if (secondary) {
    const what = result.summary || `${fails.length} failure${fails.length > 1 ? "s" : ""}`;
    out.push(`  ${C.dim}—${C.reset} ${C.bold}${result.tool}${C.reset} ${C.dim}${what}${C.reset}`);
  } else if (result.summary) {
    out.push(`  ${C.red}${C.bold}✗${C.reset} ${C.bold}${result.summary}${C.reset}`);
  } else if (fails.length) {
    const n = fails.length;
    out.push(`  ${C.red}${C.bold}✗${C.reset} ${C.bold}${n} error${n > 1 ? "s" : ""}${C.reset}` +
             `${result.guessed ? ` ${C.dim}(no parser for this tool — best guess)${C.reset}` : ""}`);
  }
  if (reported.length) {
    const sites = reported.reduce((n, u) => n + u.size, 0);
    const others = fails.length - sites;
    out.push(`    ${C.yellow}${reported.length} likely cause${reported.length > 1 ? "s" : ""}, ` +
             `${sites} site${sites > 1 ? "s" : ""}${others ? ` (+${others} other${others > 1 ? "s" : ""})` : ""}${C.reset}`);
  }
  if (since?.compared) {
    const n = since.fresh.length;
    // "nothing new" is worth a line of its own: the same wall of red as yesterday,
    // with nothing added, is a different situation from a wall that just grew.
    out.push(n
      ? `    ${C.yellow}${n} new since your last run${C.reset}`
      : `    ${C.dim}nothing new since your last run${C.reset}`);
    if (since.gone > 0) {
      out.push(`    ${C.dim}${since.gone} from that run ${since.gone > 1 ? "are" : "is"} no longer reported${C.reset}`);
    }
  } else if (since && !since.compared && since.reason === "no-previous-run") {
    out.push(`    ${C.dim}first tracked run — nothing to compare against yet${C.reset}`);
  }
  if (result.others?.length) {
    const named = result.others.map((o) => `${o.tool} (${o.count})`).join(", ");
    out.push(`    ${C.yellow}this log also contains failures from ${named}, shown below${C.reset}`);
  }
  out.push("");

  for (const unit of units.slice(0, max)) {
    const f = fails[unit.exemplar];
    const kin = unit.members.filter((i) => i !== unit.exemplar);
    // when every member shares a title once its [param] is stripped, it is one
    // parametrized family and reads better as "(N cases)" than "(+N more sites)"
    const family = unit.reported &&
      unit.members.every((i) => normTitle(fails[i].title) === normTitle(f.title));
    const loc = f.file
      ? `${C.cyan}${cwd ? relPath(f.file) : f.file}${C.reset}${C.dim}:${f.line ?? "?"}${C.reset}`
      : "";
    const label = family ? normTitle(f.title) : f.title;
    const title = label ? `  ${C.bold}${label}${C.reset}` : "";
    const more = unit.reported
      ? `  ${C.yellow}${family ? `(${unit.size} cases)` : `(+${kin.length} more site${kin.length > 1 ? "s" : ""})`}${C.reset}`
      : "";
    const isNew = since?.compared && since.fresh.includes(causeId(f))
      ? `  ${C.bold}${C.yellow}new${C.reset}` : "";
    if (loc || title) out.push(`  ${loc}${title}${more}${isNew}`);

    for (const m of String(f.message ?? "").split("\n")) {
      if (!m.trim()) continue;
      // Some tools pad a failure with a very long boilerplate line - pytest lists
      // every available fixture, rustc lists every trait impl. Keep the head of it.
      out.push(`    ${C.red}${clip(m)}${C.reset}`);
    }

    const ctx = contextFor(f.message);
    const drifted = source && stale(f.file, f.line, f.stmt);
    // "same region" is however far the last snippet actually reached, not a fixed 2
    const near = !drifted && lastSnip && lastSnip.file === f.file && Math.abs(lastSnip.line - f.line) <= lastSnip.ctx;
    const snip = !source || near || drifted ? null : snippet(f.file, f.line, ctx);
    if (drifted) {
      out.push(`      ${C.dim}│${C.reset} ${clip(f.stmt)}`);
      out.push(`      ${C.yellow}! ${relPath(f.file)} has changed since this ran — source not shown${C.reset}`);
      lastSnip = null;
    }
    if (near) {
      const one = snippet(f.file, f.line, 0);
      if (one) {
        const w = String(one[0].n).length;
        const start = windowStart(one[0].text, f.col);
        out.push(`      ${C.dim}${pad(one[0].n, w)}${C.reset} ${C.red}│${C.reset} ${windowed(one[0].text, start)}`);
        if (f.col) out.push(`      ${" ".repeat(w)} ${C.dim}│${C.reset} ${" ".repeat(windowedCol(f.col, start) - 1)}${C.red}^${C.reset}`);
      }
    }
    if (snip) {
      lastSnip = { file: f.file, line: f.line, ctx };
      out.push("");
      const w = String(snip.at(-1).n).length;
      // one offset for the whole block, taken from the line the caret sits on
      const start = windowStart(snip.find((s) => s.hit)?.text ?? "", f.col);
      for (const s of snip) {
        const bar = s.hit ? `${C.red}│${C.reset}` : `${C.dim}│${C.reset}`;
        const num = s.hit ? `${C.red}${pad(s.n, w)}${C.reset}` : `${C.dim}${pad(s.n, w)}${C.reset}`;
        const cut = windowed(s.text, start);
        const txt = s.hit ? cut : `${C.dim}${cut}${C.reset}`;
        out.push(`      ${num} ${bar} ${txt}`);
        if (s.hit && f.col) out.push(`      ${" ".repeat(w)} ${C.dim}│${C.reset} ${" ".repeat(windowedCol(f.col, start) - 1)}${C.red}^${C.reset}`);
      }
    } else if (f.stmt && !drifted) {
      out.push(`      ${C.dim}│${C.reset} ${clip(f.stmt)}`);
    }

    if (f.trace?.length > 1) {
      out.push("");
      for (const t of f.trace.slice(1)) out.push(`      ${C.grey}at ${t}${C.reset}`);
    }
    if (f.hiddenFrames > 0) {
      out.push(`      ${C.grey}+ ${f.hiddenFrames} internal frame${f.hiddenFrames > 1 ? "s" : ""} hidden${C.reset}`);
    }
    if (unit.reported && kin.length) {
      const where = (i) => {
        const g = fails[i];
        return g.file ? `${cwd ? relPath(g.file) : g.file}:${g.line ?? "?"}` : (g.title || "?");
      };
      // Parametrized cases share a source line, so the raw member list repeats one
      // location. Name each distinct place once, and say nothing when every sibling
      // sits on the line already printed above.
      const here = where(unit.exemplar);
      const elsewhere = [...new Set(kin.map(where))].filter((w) => w !== here);
      if (elsewhere.length) {
        // Long paths make three sites a 480-character line. Fill a line's worth and
        // roll the rest into the count, rather than naming a fixed number of them.
        const shown = [];
        let width = 0;
        for (const w of elsewhere) {
          if (max !== Infinity && (shown.length >= SITES_SHOWN || width + w.length > MAX_MESSAGE_LINE)) break;
          shown.push(w);
          width += w.length + 2;
        }
        if (!shown.length) shown.push(elsewhere[0]);
        out.push(`      ${C.grey}also ${shown.join(", ")}${C.reset}`);
        if (elsewhere.length > shown.length) {
          out.push(`      ${C.grey}+ ${elsewhere.length - shown.length} more places (whatbroke --all)${C.reset}`);
        }
      }
    }
    out.push("");
  }

  // A log holding a lint run, a typecheck and a test run holds three sets of failures.
  // The winner gets the room; the others get a section each rather than a count.
  const OTHER_MAX = 3;
  for (const other of secondary ? [] : (result.others ?? [])) {
    if (!other.failures?.length) continue;
    out.push("");
    out.push(render(
      { tool: other.tool, summary: other.summary, failures: other.failures, clusters: other.clusters },
      { max: max === Infinity ? Infinity : OTHER_MAX, cwd, source, cluster, secondary: true },
    ));
  }

  if (units.length > max) {
    const hidden = units.slice(max);
    const hiddenFails = hidden.reduce((n, u) => n + u.size, 0);
    const causes = hidden.filter((u) => u.reported).length;
    out.push(causes
      ? `  ${C.dim}… ${causes} more cause${causes > 1 ? "s" : ""}, ${hiddenFails} more failures (whatbroke --all)${C.reset}`
      : `  ${C.dim}… ${hiddenFails} more (whatbroke --all)${C.reset}`);
    out.push("");
  }
  return out.join("\n");
}
