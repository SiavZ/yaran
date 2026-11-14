/**
 * Saving org settings: validate first, store as one batch, then apply side effects.
 *
 * 02's validator is the gate; then the one cross-field rule the schema cannot express
 * (`pairing_policy.mode = everyone` is refused while One-time PIN is enabled). The whole
 * object is stored in one batch and audited as `settings.updated` with the changed keys.
 * Side effects run after the save and each is reported on its own, so a Cloudflare hiccup
 * says exactly which effect needs a retry: a new `pairing_policy` rewrites the Access
 * policy, a new `session_duration` asks 05 to re-apply it everywhere.
 *
 * <module-headers:begin>
 * Uses:
 * src/admin/settings-apply.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/admin/api-token.ts
 * ├── src/admin/ports.ts
 * ├── src/admin/settings-schema.ts
 * ├── src/admin/settings-store.ts
 * ├── src/console/route-types.ts
 * ├── src/setup/steps/access.ts
 * └── src/setup/steps/common.ts
 * External: none
 *
 * Used by:
 * src/admin/settings-apply.ts
 * ├── src/admin-api/routes.ts
 * ├── src/console/admin-routes.ts
 * └── test/admin-services.test.ts
 * <module-headers:end>
 */
import type { Settings } from "@yaran/protocol";
import type { Phase07Deps } from "../console/route-types.ts";
import { applyPairingPolicy, everyoneRefused } from "../setup/steps/access.ts";
import { loadRecord } from "../setup/steps/common.ts";
import { storedCf } from "./api-token.ts";
import type { Identity } from "./ports.ts";
import { readSettings, SETTINGS_KEYS, validateSettings } from "./settings-schema.ts";
import { writeKeys } from "./settings-store.ts";

export interface Effect {
  what: "pairing_policy" | "session_duration";
  ok: boolean;
}

export type SaveOutcome =
  | { ok: true; changed: string[]; effects: Effect[] }
  | { ok: false; code: "validation_failed"; errors: { path: string; message: string }[] };

const EVERYONE_WITH_OTP = "Everyone cannot be chosen while One-time PIN sign-in is on: One-time PIN admits any address that can receive mail. Switch One-time PIN off in Zero Trust first, or use an allowlist.";

export async function saveSettings(deps: Phase07Deps, actor: Identity, value: unknown): Promise<SaveOutcome> {
  const result = validateSettings(value);
  if (!result.valid) return { ok: false, code: "validation_failed", errors: result.errors.map((e) => ({ path: e.path, message: e.message })) };
  const next = value as Settings;
  const record = await loadRecord(deps.db);
  const cf = await storedCf(deps);
  if (await everyoneRefused(cf, record.account_id!, next.pairing_policy)) {
    return { ok: false, code: "validation_failed", errors: [{ path: "/pairing_policy/mode", message: EVERYONE_WITH_OTP }] };
  }
  const prev = await readSettings(deps.db);
  const changed = SETTINGS_KEYS.filter((k) => JSON.stringify(prev[k]) !== JSON.stringify(next[k]));
  await writeKeys(deps.db, Object.fromEntries(SETTINGS_KEYS.map((k) => [k, next[k]])), actor.user_id, deps.now());
  await deps.audit({ actor: { kind: "admin", id: actor.user_id }, action: "settings.updated", target: { kind: "settings" }, outcome: "ok", detail: { changed } });

  const effects: Effect[] = [];
  if (changed.includes("pairing_policy")) {
    const ok = await applyPairingPolicy(cf, record.account_id!, next.pairing_policy, record.admin_email!).then(() => true, () => false);
    effects.push({ what: "pairing_policy", ok });
  }
  if (changed.includes("session_duration")) {
    const ok = await deps.provisioning.reapplySessionDuration(next.session_duration).then(() => true, () => false);
    effects.push({ what: "session_duration", ok });
  }
  return { ok: true, changed, effects };
}
