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
  // Windows tools, and logs pasted out of Windows CI, arrive with CRLF. Every
  // parser anchors on $, so a stray \r makes all of them silently match nothing.
  const s = stripAnsi(raw).replace(/\r\n?/g, "\n");
  for (const ex of EXTRACTORS) {
    if (!ex.detect(s)) continue;
    const r = ex.extract(s);
    if (r?.failures?.length) return r;
  }
  return null;
}
