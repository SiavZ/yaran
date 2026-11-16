/**
 * `npm run token-url`: prints the account-owned API token template URL.
 *
 * The output is what the deploy README and the CF_API_TOKEN binding description link to;
 * a test fails when either drifts from `scripts/permissions.json`. `--short-keys` prints
 * gate G9's fallback form.
 *
 * <module-headers:begin>
 * Uses:
 * scripts/token-url.ts
 * └── src/setup/token-template.ts
 * External: none
 *
 * Used by: entry point (CLI: npm run token-url in cloud/worker and in the deploy tree)
 * <module-headers:end>
 */
import { tokenTemplateUrl } from "../src/setup/token-template.ts";

console.log(tokenTemplateUrl(undefined, process.argv.includes("--short-keys")));
