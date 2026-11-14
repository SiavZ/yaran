/**
 * Vitest configuration for the @yaran/machine-view plugin package.
 *
 * Runs every `test/*.test.ts` file in Node: the TypeScript half of the plugin is types,
 * the outcome tables and the shell-side machine opener, none of which need a browser.
 *
 * - No browser environment and no Capacitor runtime; the plugin proxies are mocked.
 *
 * <module-headers:begin>
 * Uses: none
 * External: vitest
 *
 * Used by: entry point (loaded by vitest, via npm test in mobile/plugins/machine-view)
 * <module-headers:end>
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
