/**
 * Shell frontend tests against test/fixtures/shell.
 *
 * Pins `source` and `.` with script-directory-relative paths (direct and through a
 * variable), relative literals, extensionless shebang scripts, absolute paths as External,
 * and computed paths reported as `unresolved` rather than dropped.
 *
 * <module-headers:begin>
 * Uses:
 * test/shell.test.mjs
 * ├── src/lang/shell.mjs
 * └── test/helpers.mjs
 * External: node:assert/strict, node:test
 *
 * Used by: entry point (node --test, via npm test in tools/module-headers)
 * <module-headers:end>
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { fixtureGraph, names } from "./helpers.mjs";
import { resolveSource } from "../src/lang/shell.mjs";

const graph = await fixtureGraph("shell", ["shell"]);

test("script-dir-relative sources resolve, computed ones are unresolved", () => {
  assert.deepEqual(names(graph, "bin/run.sh", "uses"), ["bin/local.sh", "lib/common.sh"]);
  assert.deepEqual(graph.unresolvedOf("bin/run.sh"), ['"$PLUGIN_DIR/plugin.sh"']);
  assert.deepEqual(graph.externals("bin/run.sh"), ["/etc/os-release"]);
});

test("an extensionless bash script is a shell file with edges", () => {
  assert.deepEqual(names(graph, "bin/tool", "uses"), ["bin/local.sh", "lib/common.sh"]);
  assert.deepEqual(names(graph, "lib/common.sh", "usedBy"), ["bin/run.sh", "bin/tool"]);
});

test("resolution rules", () => {
  const tracked = new Set(["a/x.sh", "lib/y.sh"]);
  assert.deepEqual(resolveSource("a/run.sh", '"$(dirname "$0")/x.sh"', [], tracked), { file: "a/x.sh" });
  assert.deepEqual(resolveSource("a/run.sh", "lib/y.sh", [], tracked), { file: "lib/y.sh" });
  assert.deepEqual(resolveSource("a/run.sh", "$D/x.sh", ["D"], tracked), { file: "a/x.sh" });
  assert.deepEqual(resolveSource("a/run.sh", "$DX/x.sh", ["D"], tracked), { unresolved: "$DX/x.sh" });
  assert.deepEqual(resolveSource("a/run.sh", "missing.sh", [], tracked), { unresolved: "missing.sh" });
});
