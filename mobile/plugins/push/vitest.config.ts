/**
 * Vitest configuration for `@yaran/push` and, until Phase 14's shell lands its own runner, the
 * shell's push orchestration in `mobile/app/src/push/`.
 *
 * - Bare imports from the shell's files resolve through this package's node_modules (the shell
 *   has none yet), and `@yaran/push` maps to this package's source.
 * - shortcut: drop the `mobile/app` include and the resolver once 14's `mobile/app` runs these tests.
 *
 * <module-headers:begin>
 * Uses: none
 * External: node:path, node:url, vitest
 *
 * Used by: entry point (loaded by vitest, via npm test in mobile/plugins/push)
 * <module-headers:end>
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vitest/config";

const here = dirname(fileURLToPath(import.meta.url));
const appPush = resolve(here, "../../app/src/push");

const appDeps: Plugin = {
  name: "yaran-app-push-deps",
  enforce: "pre",
  resolveId(source, importer, options) {
    if (!importer?.startsWith(appPush) || source.startsWith(".") || source.startsWith("/") || source.startsWith("\0")) return null;
    return this.resolve(source, join(here, "src/index.ts"), { ...options, skipSelf: true });
  },
};

export default defineConfig({
  plugins: [appDeps],
  resolve: { alias: { "@yaran/push": join(here, "src/index.ts") } },
  server: { fs: { allow: [resolve(here, "../..")] } },
  test: {
    include: ["test/**/*.test.ts", "../../app/src/push/**/*.test.{ts,tsx}"],
    environment: "node",
    server: { deps: { inline: [/mobile\/app\/src\/push/] } },
  },
});
