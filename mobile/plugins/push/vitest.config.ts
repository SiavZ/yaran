/**
 * Vitest configuration for `@yaran/push` (its contract and guards). The shell's push
 * orchestration in `mobile/app/src/push/` runs under the shell's own runner.
 *
 * <module-headers:begin>
 * Uses: none
 * External: vitest
 *
 * Used by: entry point (loaded by vitest, via npm test in mobile/plugins/push)
 * <module-headers:end>
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
