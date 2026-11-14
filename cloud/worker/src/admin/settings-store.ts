/**
 * Key/value access to 04's `settings(key, value, updated_at, updated_by)` table.
 *
 * Contract settings live under 02's `Settings` field names, one row per top-level field;
 * internal keys (setup record, control-plane host, sealed token, update status) live beside
 * them. A missing row falls back to the caller's default.
 *
 * - Values are JSON. A row that does not parse is a loud error, never a silent default.
 * - Writes are one D1 batch, so a multi-key change lands together or not at all.
 */
import type { D1Like, D1Stmt } from "./ports.ts";

export async function readKey<T>(db: D1Like, key: string): Promise<T | undefined> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  if (!row) return undefined;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    throw new Error(`settings row ${key} holds invalid JSON`);
  }
}

export async function readKeys(db: D1Like, keys: readonly string[]): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>();
  if (keys.length === 0) return out;
  const marks = keys.map(() => "?").join(",");
  const { results } = await db.prepare(`SELECT key, value FROM settings WHERE key IN (${marks})`).bind(...keys).all<{ key: string; value: string }>();
  for (const row of results) {
    try {
      out.set(row.key, JSON.parse(row.value));
    } catch {
      throw new Error(`settings row ${row.key} holds invalid JSON`);
    }
  }
  return out;
}

/** Statements that upsert each entry; run them alone or inside a larger batch. */
export function writeStatements(db: D1Like, entries: Record<string, unknown>, updatedBy: string, now: Date): D1Stmt[] {
  const at = Math.floor(now.getTime() / 1000);
  return Object.entries(entries).map(([key, value]) =>
    db
      .prepare("INSERT OR REPLACE INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)")
      .bind(key, JSON.stringify(value), at, updatedBy),
  );
}

export async function writeKeys(db: D1Like, entries: Record<string, unknown>, updatedBy: string, now: Date): Promise<void> {
  const statements = writeStatements(db, entries, updatedBy, now);
  if (statements.length > 0) await db.batch(statements);
}

export async function deleteKeys(db: D1Like, keys: readonly string[]): Promise<void> {
  if (keys.length === 0) return;
  await db.batch(keys.map((k) => db.prepare("DELETE FROM settings WHERE key = ?").bind(k)));
}
