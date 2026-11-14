/**
 * TypeScript frontend tests against test/fixtures/ts-paths.
 *
 * Pins the web UI's `@/*` alias (same tsconfig shape: a solution file with `files: []`),
 * `export * from`, dynamic import, a `.tsx` importer, a type-only import, `require`, a
 * bare package that becomes External, node builtins, and a `file:` dependency resolved
 * through its `exports` map to tracked source with no node_modules present.
 *
 * <module-headers:begin>
 * Uses:
 * test/typescript.test.mjs
 * ├── src/lang/typescript.mjs
 * └── test/helpers.mjs
 * External: node:assert/strict, node:test
 *
 * Used by: entry point (node --test, via npm test in tools/module-headers)
 * <module-headers:end>
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { fixtureGraph, names } from "./helpers.mjs";
import { exportTargets, packageName } from "../src/lang/typescript.mjs";

const graph = await fixtureGraph("ts-paths", ["ts"]);

test("a .tsx importer resolves the @/* alias, type-only, dynamic and file: imports", () => {
  assert.deepEqual(names(graph, "app/src/main.tsx", "uses"), [
    "@yaran/ui-kit:src/index.ts",
    "@yaran/ui-kit:src/tokens.ts",
    "src/lazy.ts",
    "src/lib/a.ts",
    "src/types.ts",
  ]);
  assert.deepEqual(graph.externals("app/src/main.tsx"), ["node:fs", "react"]);
});

test("export-from and require are edges", () => {
  assert.deepEqual(names(graph, "app/src/lib/a.ts", "uses"), ["src/lib/b.ts"]);
  assert.deepEqual(names(graph, "app/src/lib/b.ts", "usedBy"), ["scripts/build.cjs", "src/lib/a.ts"]);
});

test("the local package names its importers from the other package", () => {
  assert.deepEqual(names(graph, "kit/src/index.ts", "usedBy"), ["app:src/main.tsx"]);
  assert.equal(graph.rootName("kit/src/index.ts"), "src/index.ts");
});

test("exports map resolution honors key order, conditions and patterns", () => {
  const ex = { ".": { types: "./a.d.ts", import: "./a.ts" }, "./x/*": { default: "./src/x/*.ts" }, "./y": "./y.js" };
  assert.deepEqual(exportTargets(ex, "."), ["./a.d.ts", "./a.ts"]);
  assert.deepEqual(exportTargets(ex, "./x/deep"), ["./src/x/deep.ts"]);
  assert.deepEqual(exportTargets(ex, "./y"), ["./y.js"]);
  assert.deepEqual(exportTargets(ex, "./nope"), []);
  assert.deepEqual(exportTargets({ require: "./c.cjs", import: "./m.js" }, "."), ["./m.js"]);
  assert.deepEqual(exportTargets(undefined, "."), ["./index.js"]);
});

test("package names keep scopes", () => {
  assert.equal(packageName("@yaran/protocol/sig"), "@yaran/protocol");
  assert.equal(packageName("react/jsx-runtime"), "react");
});
