/**
 * Swift frontend tests against test/fixtures/swift (needs `npm run fetch-grammars`).
 *
 * Pins SwiftPM and Xcode module detection, same-module and imported-module inferred edges
 * marked `(inferred)`, the collision over-report (asserted), and External system modules.
 *
 * <module-headers:begin>
 * Uses:
 * test/swift.test.mjs
 * ├── src/lang/swift.mjs
 * └── test/helpers.mjs
 * External: node:assert/strict, node:test
 *
 * Used by: entry point (node --test, via npm test in tools/module-headers)
 * <module-headers:end>
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { fixtureGraph, names } from "./helpers.mjs";
import { swiftModuleOf } from "../src/lang/swift.mjs";

const graph = await fixtureGraph("swift", ["swift"]);

test("same-module and imported first-party module uses are inferred edges", () => {
  assert.deepEqual(names(graph, "Sources/App/Main.swift", "uses"), [
    "App/DupInt (inferred)",
    "App/DupString (inferred)",
    "App/Helper (inferred)",
    "Core/Store (inferred)",
  ]);
  assert.deepEqual(graph.externals("Sources/App/Main.swift"), ["Foundation"]);
});

test("an extension declares nothing, so it creates no edge to String's file", () => {
  assert.deepEqual(names(graph, "Sources/Core/Store.swift", "uses"), []);
  assert.deepEqual(names(graph, "Sources/Core/Store.swift", "usedBy"), ["App/Main (inferred)"]);
});

test("module detection: SwiftPM target, Xcode target directory, parent fallback", () => {
  const xc = new Set(["Xc"]);
  assert.equal(swiftModuleOf("Sources/App/Main.swift", xc), "App");
  assert.equal(swiftModuleOf("pkg/Tests/AppTests/T.swift", xc), "AppTests");
  assert.equal(swiftModuleOf("Xc/Shell/Views/Card.swift", xc), "Shell");
  assert.equal(swiftModuleOf("loose/dir/X.swift", xc), "dir");
  assert.equal(graph.rootName("Xc/Shell/Views/Card.swift"), "Shell/Card");
});
