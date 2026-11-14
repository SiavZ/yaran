/**
 * The Worker-internal settings rows Phase 07 keeps (wizard progress, the claim link, update
 * status, the sealed API token), declared for 04's settings registry.
 *
 * - No imports, so `db/settings.ts` can absorb it without a module cycle.
 * - Sealed values carry 04's `k<version>.` prefix; the token is sealed with purpose
 *   `cf_api_token` and the AAD `settings.value:cf_api_token_enc`.
 *
 * <module-headers:begin>
 * Uses: none
 * External: none
 *
 * Used by:
 * src/admin/setup-settings.ts
 * ├── src/admin/api-token.ts
 * ├── src/db/settings.ts
 * ├── src/provisioning/context.ts
 * ├── test/helpers/deps.ts
 * └── test/setup-flow.test.ts
 * <module-headers:end>
 */

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const SEALED = /^k[1-9][0-9]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export interface SetupSettingSpec<T> {
  default: T | null;
  validate: (v: unknown) => v is T;
  owner: "07";
}

export const SETUP_INTERNAL_SETTINGS = {
  setup_wizard: { default: null, validate: (v: unknown): v is Record<string, unknown> => isObject(v) && typeof v["step"] === "string", owner: "07" },
  setup_claim: { default: null, validate: (v: unknown): v is Record<string, unknown> => isObject(v) && typeof v["hash"] === "string" && Number.isInteger(v["exp"]), owner: "07" },
  update_status: { default: null, validate: isObject, owner: "07" },
  cf_api_token_enc: { default: null, validate: (v: unknown): v is string => typeof v === "string" && SEALED.test(v), owner: "07" },
  workers_dev_disabled: { default: null, validate: (v: unknown): v is boolean => typeof v === "boolean", owner: "07" },
  worker_script_name: { default: null, validate: (v: unknown): v is string => typeof v === "string" && /^[a-z0-9][a-z0-9-]{0,62}$/.test(v), owner: "07" },
} satisfies Record<string, SetupSettingSpec<unknown>>;

/** Where the sealed API token lives and how it is bound (04's settings AAD rule). */
export const API_TOKEN_KEY = "cf_api_token_enc";
export const API_TOKEN_AAD = { table: "settings", column: "value", rowId: API_TOKEN_KEY } as const;
