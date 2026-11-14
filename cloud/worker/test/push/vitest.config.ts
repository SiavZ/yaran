/**
 * Vitest configuration for the push module's Node harness.
 *
 * The module under test lives in cloud/worker/src/push and imports "@yaran/protocol", which
 * resolves from this harness's node_modules (the alias), because cloud/worker has no
 * package of its own until Phase 04 lands. D1 is an in-memory node:sqlite shim
 * (helpers/d1.ts) loaded with 04's planned schema and this phase's migration.
 *
 * <module-headers:begin>
 * Uses: none
 * External: node:url, vitest
 *
 * Used by: entry point (loaded by vitest, via npm test in cloud/worker/test/push)
 * <module-headers:end>
 */
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@yaran/protocol": fileURLToPath(new URL("./node_modules/@yaran/protocol/src/index.ts", import.meta.url)) },
  },
  test: { include: ["*.test.ts"], environment: "node" },
});
