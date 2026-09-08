import pytest from "./extractors/pytest.js";
import { traceback, unittest } from "./extractors/python.js";
import node from "./extractors/node.js";
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
import phpunit from "./extractors/phpunit.js";
import gotest from "./extractors/gotest.js";
import cargo from "./extractors/cargo.js";
import generic from "./extractors/generic.js";
import { stripAnsi } from "./util.js";

// order matters: most specific first, generic last
export const EXTRACTORS = [pytest, jest, vitest, unittest, traceback, eslint, ruff, mypy, clang, rspec, jvm, dotnet, phpunit, cargo, gotest, node, tsc, generic];

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

export function analyse(raw) {
  // Windows tools, and logs pasted out of Windows CI, arrive with CRLF. Every
  // parser anchors on $, so a stray \r makes all of them silently match nothing.
  const s = stripAnsi(raw).replace(/\r\n?/g, "\n");
  for (const ex of EXTRACTORS) {
    if (!ex.detect(s)) continue;
    const r = ex.extract(s);
    if (r?.failures?.length) {
      const failures = dedupeFailures(r.failures);
      return failures.length === r.failures.length ? r : { ...r, failures };
    }
  }
  return null;
}
