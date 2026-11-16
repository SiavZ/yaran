/**
 * Graph model tests: reverse edges, the inferred flag merge, sorting and self edges.
 *
 * <module-headers:begin>
 * Uses:
 * test/graph.test.mjs
 * └── src/graph.mjs
 * External: node:assert/strict, node:test
 *
 * Used by: entry point (node --test, via npm test in tools/module-headers)
 * <module-headers:end>
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Graph } from "../src/graph.mjs";

test("edges are mirrored, sorted by name, and self edges dropped", () => {
  const g = new Graph();
  g.addEdge("a", "c");
  g.addEdge("a", "b");
  g.addEdge("a", "a");
  assert.deepEqual(g.entries("a", "uses").map((e) => e.name), ["b", "c"]);
  assert.deepEqual(g.entries("b", "usedBy").map((e) => e.name), ["a"]);
  assert.deepEqual(g.entries("a", "usedBy"), []);
});

test("an edge found both by import and by inference is not inferred", () => {
  const g = new Graph();
  g.addEdge("a", "b", { inferred: true });
  assert.equal(g.entries("a", "uses")[0].inferred, true);
  g.addEdge("a", "b");
  g.addEdge("a", "b", { inferred: true });
  assert.equal(g.entries("a", "uses")[0].inferred, false);
  assert.equal(g.entries("b", "usedBy")[0].inferred, false);
});

test("names come from the target's namer and depend on the viewer", () => {
  const g = new Graph();
  g.addNode("x.rs", (t, viewer) => (viewer === "y.rs" ? "short" : "long::x"), "x.rs");
  g.addEdge("y.rs", "x.rs");
  g.addEdge("z.rs", "x.rs");
  assert.equal(g.nameOf("x.rs", "y.rs"), "short");
  assert.equal(g.nameOf("x.rs", "z.rs"), "long::x");
  g.addExternal("y.rs", "std");
  g.addExternal("y.rs", "anyhow");
  assert.deepEqual(g.externals("y.rs"), ["anyhow", "std"]);
});
