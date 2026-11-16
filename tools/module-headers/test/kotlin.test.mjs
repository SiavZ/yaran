/**
 * Kotlin frontend tests against test/fixtures/kotlin.
 *
 * Pins import resolution through the declaration index, wildcard imports, same-package
 * inferred edges marked `(inferred)`, the known collision over-report (two `dup` overloads
 * in two files both get the edge; asserted so a future fix is visible), and External.
 *
 * <module-headers:begin>
 * Uses:
 * test/kotlin.test.mjs
 * └── test/helpers.mjs
 * External: node:assert/strict, node:test
 *
 * Used by: entry point (node --test, via npm test in tools/module-headers)
 * <module-headers:end>
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { fixtureGraph, names } from "./helpers.mjs";

const K = "src/main/kotlin/dev/example";
const graph = await fixtureGraph("kotlin", ["kotlin"]);

test("explicit imports are plain edges; same-package and wildcard uses are inferred", () => {
  assert.deepEqual(names(graph, `${K}/app/Main.kt`, "uses"), [
    "dev.example.app.DupInt (inferred)",
    "dev.example.app.DupString (inferred)",
    "dev.example.app.Helper (inferred)",
    "dev.example.core.Store",
    "dev.example.util.Formatter (inferred)",
  ]);
});

test("an unresolved import is External as its package", () => {
  assert.deepEqual(graph.externals(`${K}/app/Main.kt`), ["androidx.core"]);
});

test("used-by is the reverse, and the node name is package plus file stem", () => {
  assert.deepEqual(names(graph, `${K}/core/Store.kt`, "usedBy"), ["dev.example.app.Main"]);
  assert.equal(graph.rootName(`${K}/core/Store.kt`), "dev.example.core.Store");
});
