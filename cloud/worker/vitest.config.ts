/**
 * Vitest configuration for the control-plane Worker: every test runs inside workerd.
 *
 * The Cloudflare Vitest plugin starts Miniflare from `wrangler.jsonc`, so the tests see
 * the same D1, rate-limit and compatibility settings a deploy does. The D1 migrations are
 * read here (in Node) and handed to the tests as the `TEST_MIGRATIONS` binding, which
 * `test/setup.ts` applies to each test file's isolated database.
 *
 * - Secrets are fixed test values bound here, never real credentials.
 *
 * <module-headers:begin>
 * Uses: none
 * External: @cloudflare/vitest-plugin, vitest
 *
 * Used by: entry point (loaded by vitest, via npm test in cloud/worker)
 * <module-headers:end>
 */
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export const TEST_SECRETS = {
  CF_API_TOKEN: "test-cf-api-token-0000",
  SETUP_CODE: "test-setup-code-0000-0000-0000",
  // base64 of 32 bytes: the Phase 02 consent-cookie fixture's DATA_KEY.
  DATA_KEY: "zqRjVcBnSVWV7LfSGmWagKnIeDIIJRGDYvd/VUbBWsU=",
};

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: { bindings: { ...TEST_SECRETS, TEST_MIGRATIONS: migrations } },
      }),
    ],
    test: {
      include: ["test/**/*.test.ts"],
      setupFiles: ["./test/setup.ts"],
    },
  };
});
