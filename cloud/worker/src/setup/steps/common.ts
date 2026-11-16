/**
 * Shared plumbing for the wizard steps: load and persist the setup record.
 *
 * The record lives under the internal settings key `setup_wizard`; each advance also
 * writes the facts other phases read by their own names (04's `account_id`, `zone_id`,
 * `control_plane_host`, `team_domain`, `control_plane_app_id`, `control_plane_aud`, …).
 *
 * - A refused transition is returned, never thrown, so the page can say why.
 *
 * <module-headers:begin>
 * Uses:
 * src/setup/steps/common.ts
 * ├── src/admin/settings-store.ts
 * └── src/setup/wizard-state.ts
 * External: none
 *
 * Used by:
 * src/setup/steps/common.ts
 * ├── src/admin/health.ts
 * ├── src/admin/settings-apply.ts
 * ├── src/console/admin-routes.ts
 * ├── src/setup/routes.ts
 * ├── src/setup/steps/claim.ts
 * ├── test/admin-services.test.ts
 * ├── test/console.test.ts
 * └── test/setup-flow.test.ts
 * <module-headers:end>
 */
import { readKey, writeStatements } from "../../admin/settings-store.ts";
import { INITIAL_SETUP, reduce, type SetupEvent, type SetupRecord } from "../wizard-state.ts";

export const RECORD_KEY = "setup_wizard";

export async function loadRecord(db: D1Database): Promise<SetupRecord> {
  return (await readKey<SetupRecord>(db, RECORD_KEY)) ?? INITIAL_SETUP;
}

/** The 04-named settings keys mirrored from the record. */
export function mirroredKeys(r: SetupRecord): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const map: [string, unknown][] = [
    ["account_id", r.account_id],
    ["zone_id", r.zone_id],
    ["zone_name", r.zone_name],
    ["control_plane_host", r.cp_host],
    ["team_domain", r.team_domain],
    ["control_plane_app_id", r.access_app_id],
    ["control_plane_aud", r.access_aud],
    ["worker_script_name", r.script_name],
  ];
  for (const [k, v] of map) if (v !== undefined) out[k] = v;
  return out;
}

export async function advance(db: D1Database, record: SetupRecord, event: SetupEvent, now: Date): Promise<{ ok: true; record: SetupRecord } | { ok: false; reason: string }> {
  const t = reduce(record, event);
  if (!t.ok) return t;
  await db.batch(writeStatements(db, { [RECORD_KEY]: t.record, ...mirroredKeys(t.record) }, "setup", now));
  return t;
}
