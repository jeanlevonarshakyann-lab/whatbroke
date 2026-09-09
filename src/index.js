import pytest from "./extractors/pytest.js";
import { traceback, unittest } from "./extractors/python.js";
import node from "./extractors/node.js";
import nodetest from "./extractors/nodetest.js";
import tsc from "./extractors/tsc.js";
import jest from "./extractors/jest.js";
import vitest from "./extractors/vitest.js";
import eslint from "./extractors/eslint.js";
import ruff from "./extractors/ruff.js";
import mypy from "./extractors/mypy.js";
import clang from "./extractors/clang.js";
import rspec from "./extractors/rspec.js";
import jvm from "./extractors/jvm.js";
import dotnet from "./extractors/dotnet.js";
import dotnettest from "./extractors/dotnettest.js";
import phpunit from "./extractors/phpunit.js";
import gotest from "./extractors/gotest.js";
import cargo from "./extractors/cargo.js";
import generic from "./extractors/generic.js";
import { stripAnsi, stripCiPrefix } from "./util.js";
import { clusterFailures } from "./cluster.js";

// order matters: most specific first, generic last
export const EXTRACTORS = [pytest, nodetest, jest, vitest, unittest, traceback, eslint, ruff, mypy, clang, rspec, jvm, dotnettest, dotnet, phpunit, cargo, gotest, node, tsc, generic];

function dedupeFailures(failures) {
  const seen = new Set();
  return failures.filter((failure) => {
    const key = JSON.stringify([
      failure.file ?? null, failure.line ?? null, failure.col ?? null,
      failure.title ?? "", failure.message ?? "", failure.stmt ?? "",
    ]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function analyse(raw, { cluster = true } = {}) {
  // Windows tools, and logs pasted out of Windows CI, arrive with CRLF. Every
  // parser anchors on $, so a stray \r makes all of them silently match nothing.
  const s = stripCiPrefix(stripAnsi(raw).replace(/\r\n?/g, "\n"));
  for (const ex of EXTRACTORS) {
    if (!ex.detect(s)) continue;
    const r = ex.extract(s);
    if (r?.failures?.length) {
      // dedupe first: it collapses the SAME diagnostic printed twice, so cluster
      // sizes end up counting real distinct sites rather than print repetitions.
      const failures = dedupeFailures(r.failures);
      const clusters = cluster ? clusterFailures(failures, r.tool) : null;
      return { ...r, failures, clusters };
    }
  }
  return null;
}
