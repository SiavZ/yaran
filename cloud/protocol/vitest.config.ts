/**
 * Vitest configuration for the @yaran/protocol package.
 *
 * Runs every `test/*.test.ts` file in Node, where WebCrypto (`crypto.subtle`)
 * offers the same algorithms the Worker runtime does.
 *
 * - No browser environment: the codecs under test use only WebCrypto and TextEncoder.
 *
 * <module-headers:begin>
 * Uses:
 * vitest.config.ts
 * External: vitest/config
 *
 * Used by: entry point (vitest, via npm test)
 * <module-headers:end>
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
