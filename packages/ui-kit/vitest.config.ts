/**
 * Vitest configuration for the kit's own suite.
 *
 * The moved component tests pick jsdom per file (`@vitest-environment jsdom`); the
 * token guard and the native color export tests run in plain Node.
 *
 * - Compiles JSX with the same React plugin the web build uses.
 *
 * <module-headers:begin>
 * Uses: none
 * External: @vitejs/plugin-react, vitest
 *
 * Used by: entry point (loaded by vitest, via npm test in packages/ui-kit)
 * <module-headers:end>
 */
import react from "@vitejs/plugin-react"
import { defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [react()],
  test: { include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.mjs"] },
})
