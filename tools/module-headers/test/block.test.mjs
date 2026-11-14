/**
 * Block rendering and rewriting tests: golden files for each language, idempotence and
 * annotation preservation.
 *
 * Each golden input under test/fixtures/golden is written against one synthetic graph;
 * the output must equal its `.out` twin byte for byte, writing the output again must
 * change nothing, and the check mode must then find no drift.
 *
 * <module-headers:begin>
 * Uses:
 * test/block.test.mjs
 * ├── src/block.mjs
 * ├── src/graph.mjs
 * ├── src/headers.mjs
 * ├── src/render.mjs
 * └── test/helpers.mjs
 * External: node:assert/strict, node:fs, node:path, node:test
 *
 * Used by: entry point (node --test, via npm test in tools/module-headers)
 * <module-headers:end>
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURES } from "./helpers.mjs";
import { Graph } from "../src/graph.mjs";
import { checkFile } from "../src/headers.mjs";
import { renderBlock, parseAnnotations } from "../src/render.mjs";
import { applyBlock, findHeader, hasTitle } from "../src/block.mjs";

/**
 * A graph where `file` (named `root`) uses `uses` and is used by `usedBy`.
 * @param {string} file
 * @param {string} root
 * @param {string[]} uses
 * @param {[string, boolean][]} usedBy
 */
function graphFor(file, root, uses, usedBy) {
  const g = new Graph();
  const id = (/** @type {string} */ t) => t;
  g.addNode(file, id, root);
  for (const u of uses) {
    g.addNode(u, id, u);
    g.addEdge(file, u);
  }
  for (const [u, inferred] of usedBy) {
    g.addNode(u, id, u);
    g.addEdge(u, file, { inferred });
  }
  g.addExternal(file, "std");
  return g;
}

const CASES = [
  { name: "rust.in.rs", lang: "rust", root: "cloud/supervisor.rs", uses: ["cloud::credentials", "cloud::ready_probe"], usedBy: [["cloud::leg", false]] },
  { name: "ts.in.ts", lang: "ts", root: "src/lib/native/detect.ts", uses: ["src/lib/a.ts"], usedBy: [["src/App.tsx", false]] },
  { name: "ts-line.in.ts", lang: "ts", root: "src/lib/y.ts", uses: [], usedBy: [["src/App.tsx", false]] },
  { name: "kotlin.in.kt", lang: "kotlin", root: "dev.yaran.app.MachineView", uses: ["dev.yaran.core.Session"], usedBy: [["dev.yaran.app.Old", true], ["dev.yaran.app.Plugin", true]] },
  { name: "swift.in.swift", lang: "swift", root: "App/SessionStore", uses: ["App/Keychain"], usedBy: [["App/AppDelegate", true]] },
  { name: "shell.in.sh", lang: "shell", root: "tools/cloud-gates/run.sh", uses: ["tools/cloud-gates/lib/common.sh"], usedBy: [] },
];

for (const c of CASES) {
  test(`golden ${c.name}: write, idempotence, clean check`, () => {
    const input = readFileSync(join(FIXTURES, "golden", c.name), "utf8");
    const expected = readFileSync(join(FIXTURES, "golden", c.name.replace(".in.", ".out.")), "utf8");
    const g = graphFor(c.name, c.root, c.uses, /** @type {[string, boolean][]} */ (c.usedBy));
    const entry = c.usedBy.length === 0 ? "bash tools/cloud-gates/run.sh G<NN>" : undefined;
    const first = checkFile({ path: c.name, text: input, lang: c.lang }, g, entry, true);
    assert.equal(first.text, expected);
    assert.deepEqual(first.problems, []);
    const second = checkFile({ path: c.name, text: first.text, lang: c.lang }, g, entry, true);
    assert.equal(second.text, first.text, "a second --write changes nothing");
    assert.deepEqual(checkFile({ path: c.name, text: first.text, lang: c.lang }, g, entry, false).problems, []);
  });
}

test("annotations survive regeneration and inferred is not an annotation", () => {
  const ann = parseAnnotations(["Uses:", "x", "├── a::b (inferred)  (why)", "└── c", "External: none", "Used by:", "x", "└── d   (note (nested))"]);
  assert.deepEqual([...ann.uses], [["a::b", "(why)"]]);
  assert.deepEqual([...ann.usedBy], [["d", "(note (nested))"]]);
  const out = renderBlock({ root: "x", uses: [{ name: "a::b", inferred: true }, { name: "zz", inferred: false }], unresolved: [], external: [], usedBy: [], annotations: ann });
  assert.ok(out.includes("├── a::b (inferred)  (why)"), out.join("\n"));
});

test("inserting into a file with no header creates one that fails the title check", () => {
  const block = renderBlock({ root: "r", uses: [], unresolved: [], external: [], usedBy: [], entryPoint: "cli" });
  const text = applyBlock("#!/usr/bin/env node\nconsole.log(1);\n", "ts", block);
  assert.ok(text.startsWith("#!/usr/bin/env node\n/**\n * <module-headers:begin>\n"), text);
  const lines = text.split("\n");
  assert.equal(hasTitle(lines, findHeader(lines, "ts")), false);
});

test("a one-line KDoc is split around the inserted block", () => {
  const block = renderBlock({ root: "r", uses: [], unresolved: [], external: [], usedBy: [], entryPoint: "x" });
  const text = applyBlock("/** Title only. */\npackage a\n", "kotlin", block);
  assert.ok(text.startsWith("/** Title only.\n *\n * <module-headers:begin>\n"), text);
  assert.ok(text.includes(" * <module-headers:end>\n */\npackage a\n"), text);
});

test("a directive alone is not a title", () => {
  const lines = ["#!/bin/sh", "# shellcheck disable=SC1090", "# <module-headers:begin>", "# <module-headers:end>"];
  assert.equal(hasTitle(lines, findHeader(lines, "shell")), false);
});
