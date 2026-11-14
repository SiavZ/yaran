/**
 * ESLint flat config for the control-plane Worker, mirroring
 * crates/yaran-web/web/eslint.config.js minus the React rules.
 *
 * <module-headers:begin>
 * Uses: none
 * External: @eslint/js, eslint, typescript-eslint
 *
 * Used by: entry point (loaded by eslint, via npm run lint in cloud/worker)
 * <module-headers:end>
 */
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig([
  globalIgnores(["dist", ".wrangler", "worker-configuration.d.ts"]),
  {
    files: ["**/*.{ts,js}"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    rules: {
      // Same options as the web UI: `^_` marks a deliberately unused parameter or caught
      // error, and rest siblings may be dropped.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { ignoreRestSiblings: true, argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
]);
