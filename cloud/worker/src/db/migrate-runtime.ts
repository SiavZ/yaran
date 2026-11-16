/**
 * Runtime migrator: G11's fallback L1, for a deploy whose build could not run
 * `wrangler d1 migrations apply`. Before any route is served, on the first request or cron
 * run of an isolate, it applies the migrations the database does not have yet.
 *
 * The SQL is the same `migrations/*.sql` files wrangler applies, bundled as text modules.
 * A migration counts as applied if wrangler recorded it (`d1_migrations`) or this module
 * did (`schema_migrations`). One migration is one D1 batch (one transaction) together
 * with its `schema_migrations` row, so a failing statement records nothing. A lease row
 * stops two isolates applying the same migration; the loser waits, then re-reads.
 *
 * - Disabled with the var `RUNTIME_MIGRATIONS = "off"`.
 * - A failure is `503 unavailable` plus an error log line naming the migration.
 *
 * <module-headers:begin>
 * Uses:
 * src/db/migrate-runtime.ts
 * ├── src/db/client.ts
 * └── src/log/logger.ts
 * External: none
 *
 * Used by:
 * src/db/migrate-runtime.ts
 * ├── src/index.ts
 * └── test/migrate-runtime.test.ts
 * <module-headers:end>
 */
import init from "../../migrations/0001_init.sql";
import pairing from "../../migrations/0006_pairing.sql";
import push from "../../migrations/0008_push.sql";
import { all, run, stmt } from "./client.ts";
import type { Logger } from "../log/logger.ts";

export interface Migration {
  name: string;
  sql: string;
}

/** Every migration, in order. A new `migrations/000N_*.sql` file adds one line here. */
export const MIGRATIONS: readonly Migration[] = [
  { name: "0001_init.sql", sql: init },
  { name: "0006_pairing.sql", sql: pairing },
  { name: "0008_push.sql", sql: push },
];

const LEASE = "~lease";
export const LEASE_STALE_S = 60;

/** Splits SQL into statements, dropping `--` comments and respecting quoted text. */
export function splitSql(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]!;
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
    } else if (c === "'" || c === '"') {
      quote = c;
      cur += c;
    } else if (c === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      cur += "\n";
    } else if (c === ";") {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

async function appliedNames(db: D1Database): Promise<Set<string>> {
  await run(db, "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const names = (await all<{ version: string }>(db, "SELECT version FROM schema_migrations")).map((r) => r.version);
  const wrangler = await all<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'd1_migrations'");
  if (wrangler.length) names.push(...(await all<{ name: string }>(db, "SELECT name FROM d1_migrations")).map((r) => r.name));
  return new Set(names);
}

/** Applies every pending migration; returns the names it applied. */
export async function migrate(db: D1Database, log: Logger, now: () => number, migrations = MIGRATIONS, waitMs = 250): Promise<string[]> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const done = await appliedNames(db);
    const pending = migrations.filter((m) => !done.has(m.name));
    if (!pending.length) return [];
    await run(db, "DELETE FROM schema_migrations WHERE version = ? AND applied_at < ?", LEASE, now() - LEASE_STALE_S);
    if ((await run(db, "INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)", LEASE, now())) !== 1) {
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    const applied: string[] = [];
    try {
      for (const m of pending) {
        try {
          await db.batch([
            ...splitSql(m.sql).map((s) => db.prepare(s)),
            stmt(db, "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", m.name, now()),
          ]);
        } catch (err) {
          log.error("migration_failed", { migration: m.name, error: err, action: "Fix the migration or apply it with wrangler d1 migrations apply, then retry." });
          throw err;
        }
        applied.push(m.name);
        log.info("migration_applied", { migration: m.name });
      }
      return applied;
    } finally {
      await run(db, "DELETE FROM schema_migrations WHERE version = ?", LEASE);
    }
  }
  throw new Error("timed out waiting for another isolate to finish migrating");
}

let ready: Promise<unknown> | null = null;

/** Migrates once per isolate; a failure is retried on the next request. */
export function ensureMigrated(db: D1Database, log: Logger, now: () => number): Promise<unknown> {
  ready ??= migrate(db, log, now).catch((err) => {
    ready = null;
    throw err;
  });
  return ready;
}
