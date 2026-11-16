/**
 * Rotating the org's push keys (the VAPID pair) from the admin console.
 *
 * For a key that may have leaked, or one a lost `DATA_KEY` made unreadable: a new pair
 * overwrites the old without opening it, and every phone that was receiving pushes is
 * marked `auth_failed`, the state 08 gives a phone the push service refuses after a
 * rotation, so the fan-out stops sending to it and the app registers again with the new
 * `Meta.push.vapid_public_key` (16).
 *
 * - Audited as `settings.updated`, like the console's other key and token changes.
 *
 * <module-headers:begin>
 * Uses:
 * src/admin/vapid-rotate.ts
 * ├── src/console/route-types.ts
 * └── src/setup/steps/keys.ts
 * External: none
 *
 * Used by:
 * src/admin/vapid-rotate.ts
 * ├── src/console/admin-routes.ts
 * └── test/vapid-rotate.test.ts
 * <module-headers:end>
 */
import type { Phase07Deps } from "../console/route-types.ts";
import { writeNewVapidKey } from "../setup/steps/keys.ts";

export async function rotateVapidKey(deps: Phase07Deps, actorId: string): Promise<{ phones: number }> {
  await writeNewVapidKey(deps.db, deps.sealer, deps.now(), actorId);
  const r = await deps.db.prepare("UPDATE devices SET push_state = 'auth_failed' WHERE push_state IN ('active', 'failing')").run();
  const phones = r.meta.changes;
  await deps.audit({ actor: { kind: "admin", id: actorId }, action: "settings.updated", target: { kind: "settings" }, outcome: "ok", detail: { changed: ["vapid_public_key"], phones_reregistering: phones } });
  return { phones };
}
