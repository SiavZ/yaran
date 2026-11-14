/**
 * The D1 access layer: the four helpers every repository uses, so SQL is always bound
 * (never interpolated) and a write always reports how many rows it changed.
 *
 * Writes that must not both win use a guarded `UPDATE … WHERE <expected state>` and read
 * `changes`; inserts that may race use `INSERT OR IGNORE`. The layer avoids `RETURNING`
 * and `ON CONFLICT DO UPDATE` because D1's SQLite version is undocumented (UNVERIFIED).
 *
 * - `batch` runs as one SQL transaction and counts as one query against the cap.
 * - Never enable the D1 Sessions API (read replication) for the nonce or rate tables:
 *   their uniqueness checks rely on every query reaching the primary.
 *
 * <module-headers:begin>
 * Uses: none
 * External: none
 *
 * Used by:
 * src/db/client.ts
 * ├── src/audit/audit.ts
 * ├── src/auth/identity.ts
 * ├── src/auth/nonce-store.ts
 * ├── src/db/machines.ts
 * ├── src/db/migrate-runtime.ts
 * ├── src/db/settings.ts
 * ├── src/db/users.ts
 * ├── src/scheduled/dispatcher.ts
 * ├── src/scheduled/purge.ts
 * ├── src/security/rate-limit.ts
 * ├── test/audit.test.ts
 * ├── test/data-key.test.ts
 * ├── test/dispatcher.test.ts
 * ├── test/helpers/seed.ts
 * ├── test/machine-signature.test.ts
 * ├── test/migrate-runtime.test.ts
 * ├── test/migrations.test.ts
 * ├── test/no-secret-leak.test.ts
 * ├── test/purge.test.ts
 * ├── test/rate-limit.test.ts
 * └── test/settings.test.ts
 * <module-headers:end>
 */

export type Param = string | number | null | ArrayBuffer | Uint8Array;

/** A bound statement, for `batch`. */
export function stmt(db: D1Database, sql: string, ...params: Param[]): D1PreparedStatement {
  return db.prepare(sql).bind(...params);
}

/** The first row, or null. */
export async function one<T>(db: D1Database, sql: string, ...params: Param[]): Promise<T | null> {
  return stmt(db, sql, ...params).first<T>();
}

/** Every row. */
export async function all<T>(db: D1Database, sql: string, ...params: Param[]): Promise<T[]> {
  return (await stmt(db, sql, ...params).all<T>()).results;
}

/** Runs a write and returns the number of rows it changed. */
export async function run(db: D1Database, sql: string, ...params: Param[]): Promise<number> {
  return (await stmt(db, sql, ...params).run()).meta.changes;
}

/** Runs statements in one transaction; returns each statement's changed-row count. */
export async function batch(db: D1Database, statements: D1PreparedStatement[]): Promise<number[]> {
  const results = await db.batch(statements);
  return results.map((r) => r.meta.changes);
}

/** A D1 BLOB column as bytes (D1 returns BLOBs as number arrays or ArrayBuffers). */
export function blob(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  throw new Error("expected a BLOB column");
}
