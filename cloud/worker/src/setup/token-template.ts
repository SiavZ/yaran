/**
 * Account-owned API token template URL, built from the permission manifest.
 *
 * The admin creates the control plane's Cloudflare API token from this link, so it must
 * name exactly the permissions in `scripts/permissions.json` and nothing else. The setup
 * wizard, `npm run token-url` and the deploy README all use this one function, and a test
 * fails when the README link drifts from it.
 *
 * - Keys are 32-hex permission group IDs (the documented "most reliable option"); with
 *   `shortKeys: true` it emits the documented short keys instead (gate G9's fallback), and
 *   rows with no official short key are left to the capability probe to name.
 * - Pure: no I/O.
 *
 * <module-headers:begin>
 * Uses:
 * src/setup/token-template.ts
 * └── cloud/worker/scripts/permissions.json
 * External: none
 *
 * Used by:
 * src/setup/token-template.ts
 * ├── scripts/token-url.ts
 * ├── src/setup/capability-probe.ts
 * ├── src/setup/pages.tsx
 * ├── test/token-template.test.ts
 * └── test/ui-kit.test.tsx
 * <module-headers:end>
 */
import manifest from "../../scripts/permissions.json" with { type: "json" };

export type PermissionScope = "account" | "zone";

export interface PermissionRow {
  id: string;
  name: string;
  scope: PermissionScope;
  short_key: string | null;
  source: "official" | "datamine";
  endpoints: string[];
  probe: string;
  purpose: string;
}

export const PERMISSIONS: readonly PermissionRow[] = manifest.permissions as PermissionRow[];
export const TOKEN_NAME: string = manifest.token_name;

const TEMPLATE_BASE = "https://dash.cloudflare.com/?to=/:account/api-tokens";

/** The `permissionGroupKeys` JSON array the dashboard form pre-fills from. */
export function permissionGroupKeys(rows: readonly PermissionRow[], shortKeys = false): { key: string; type: "edit" | "read" }[] {
  const keys: { key: string; type: "edit" | "read" }[] = [];
  for (const row of rows) {
    const key = shortKeys ? row.short_key : row.id;
    if (key) keys.push({ key, type: row.name.endsWith(" Read") ? "read" : "edit" });
  }
  return keys;
}

/** The account-owned token template URL for the given rows (all of them by default). */
export function tokenTemplateUrl(rows: readonly PermissionRow[] = PERMISSIONS, shortKeys = false): string {
  const keys = encodeURIComponent(JSON.stringify(permissionGroupKeys(rows, shortKeys)));
  return `${TEMPLATE_BASE}&permissionGroupKeys=${keys}&name=${encodeURIComponent(TOKEN_NAME)}`;
}
