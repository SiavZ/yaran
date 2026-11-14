/**
 * Key/value access to 04's `settings(key, value, updated_at, updated_by)` table.
 *
 * Contract settings live under 02's `Settings` field names, one row per top-level field;
 * internal keys (setup record, control-plane host, sealed token, update status) live beside
 * them. A missing row falls back to the caller's default.
 *
 * - Every key is one 04's registry declares (`db/settings.ts`, Phase 07's rows in
 *   `setup-settings.ts`); reads and writes go through its validators, so a stray key or an
 *   invalid value is a loud error, never a silent default.
 * - Writes are one D1 batch, so a multi-key change lands together or not at all.
 *
 * <module-headers:begin>
 * Uses:
 * src/admin/settings-store.ts
 * └── src/db/settings.ts
 * External: none
 *
 * Used by:
 * src/admin/settings-store.ts
 * ├── src/admin/api-token.ts
 * ├── src/admin/health.ts
 * ├── src/admin/settings-apply.ts
 * ├── src/console/admin-routes.ts
 * ├── src/console/routes.ts
 * ├── src/setup/routes.ts
 * ├── src/setup/steps/claim.ts
 * ├── src/setup/steps/common.ts
 * ├── src/setup/steps/keys.ts
 * ├── src/update/update-checker.ts
 * ├── test/admin-services.test.ts
 * ├── test/helpers/deps.ts
 * ├── test/setup-flow.test.ts
 * ├── test/setup-steps.test.ts
 * └── test/vapid-rotate.test.ts
 * <module-headers:end>
 */
import { getStoredSettings, settingStatement, type SettingKey } from "../db/settings.ts";

/** One stored value (validated by 04's registry), or undefined when the row is absent. */
export async function readKey<T>(db: D1Database, key: string): Promise<T | undefined> {
  return (await getStoredSettings(db, [key]))[key] as T | undefined;
}

export async function readKeys(db: D1Database, keys: readonly string[]): Promise<Map<string, unknown>> {
  return new Map(Object.entries(await getStoredSettings(db, keys)));
}

/** Statements that upsert each entry through 04's validating writer; batch them as needed. */
export function writeStatements(db: D1Database, entries: Record<string, unknown>, updatedBy: string, now: Date): D1PreparedStatement[] {
  const at = Math.floor(now.getTime() / 1000);
  return Object.entries(entries).map(([key, value]) => settingStatement(db, key as SettingKey, value as never, updatedBy, at));
}

export async function writeKeys(db: D1Database, entries: Record<string, unknown>, updatedBy: string, now: Date): Promise<void> {
  const statements = writeStatements(db, entries, updatedBy, now);
  if (statements.length > 0) await db.batch(statements);
}

export async function deleteKeys(db: D1Database, keys: readonly string[]): Promise<void> {
  if (keys.length === 0) return;
  await db.batch(keys.map((k) => db.prepare("DELETE FROM settings WHERE key = ?").bind(k)));
}
