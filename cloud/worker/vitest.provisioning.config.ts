/**
 * Vitest configuration for the Phase 05 provisioning suite.
 *
 * Runs `test/provisioning/**` in Node: the suite uses `node:sqlite` as its D1 stand-in and an
 * injected fake `fetch` for Cloudflare, so it needs no Workers pool. Phase 04's Workers-pool
 * config must exclude this directory and run it through this file (a Vitest project).
 *
 * <module-headers:begin>
 * Uses: none
 * External: vitest
 *
 * Used by: entry point (loaded by vitest, via npm run test:provisioning in cloud/worker)
 * <module-headers:end>
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/provisioning/**/*.test.ts"],
    environment: "node",
    setupFiles: ["test/provisioning/setup.ts"],
  },
});
