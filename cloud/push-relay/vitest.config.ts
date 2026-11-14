/**
 * Vitest configuration for the push relay. The core suite (test/relay.test.ts) runs once
 * against the runtime-agnostic handler and once against the Node runtime over real HTTP with
 * a node:http2 mock APNs server; RELAY_RUNTIMES (core,node) narrows it.
 *
 * <module-headers:begin>
 * Uses: none
 * External: vitest
 *
 * Used by: entry point (loaded by vitest, via npm test in cloud/push-relay)
 * <module-headers:end>
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/**/*.test.ts"], environment: "node" },
});
