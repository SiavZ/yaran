/// <reference types="vite/client" />
//
// <module-headers:begin>
// Uses: none
// External: cloudflare:test
//
// Used by: entry point (ambient test typings, included by cloud/worker/tsconfig.json)
// <module-headers:end>
/**
 * Test-only typings: the `TEST_MIGRATIONS` binding vitest.config.ts injects, and Vite's
 * client types for `import.meta.glob`.
 *
 * <module-headers:begin>
 * <module-headers:end>
 */
import type { D1Migration } from "cloudflare:test";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
