import pytest from "./extractors/pytest.js";
import { traceback, unittest } from "./extractors/python.js";
import node from "./extractors/node.js";
import tsc from "./extractors/tsc.js";
import jest from "./extractors/jest.js";
import vitest from "./extractors/vitest.js";
import eslint from "./extractors/eslint.js";
import gotest from "./extractors/gotest.js";
import cargo from "./extractors/cargo.js";
import generic from "./extractors/generic.js";
import { stripAnsi } from "./util.js";

// order matters: most specific first, generic last
export const EXTRACTORS = [pytest, jest, vitest, unittest, traceback, eslint, cargo, gotest, node, tsc, generic];

export function analyse(raw) {
  const s = stripAnsi(raw);
  for (const ex of EXTRACTORS) {
    if (!ex.detect(s)) continue;
    const r = ex.extract(s);
    if (r?.failures?.length) return r;
  }
  return null;
}
