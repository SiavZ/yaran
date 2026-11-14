/**
 * Phase 04's cron tasks: the purges that keep D1 small, and the reseal that finishes a
 * `DATA_KEY` rotation.
 *
 * | Task                  | Every   | Deletes                                              |
 * | `purge_nonces`        | 10 min  | machine nonces past their expiry                     |
 * | `purge_pair_requests` | 10 min  | pair requests expired over a day ago (06's rows)     |
 * | `purge_audit`         | daily   | audit rows past `audit_retention_days`               |
 * | `purge_rate_counters` | hourly  | rate windows that ended over a day ago               |
 * | `reseal_data`         | hourly  | nothing: re-seals rows still under the previous key  |
 *
 * Each run is a bounded chunk; a full chunk asks for another run on the next tick.
 *
 * <module-headers:begin>
 * Uses:
 * src/scheduled/purge.ts
 * ├── src/audit/audit.ts
 * ├── src/auth/nonce-store.ts
 * ├── src/db/client.ts
 * ├── src/db/settings.ts
 * ├── src/http/context.ts
 * ├── src/scheduled/tasks.ts
 * ├── src/security/data-key.ts
 * └── src/security/rate-limit.ts
 * External: none
 *
 * Used by:
 * src/scheduled/purge.ts
 * ├── src/scheduled/tasks.ts
 * ├── test/data-key.test.ts
 * └── test/purge.test.ts
 * <module-headers:end>
 */
import { purgeAudit } from "../audit/audit.ts";
import { purgeExpiredNonces } from "../auth/nonce-store.ts";
import { all, batch, run, stmt } from "../db/client.ts";
import { compareAndSetSetting, getSetting } from "../db/settings.ts";
import type { AppContext } from "../http/context.ts";
import { DataKeyError, keyRing, open, seal, sealedVersion, type SealPurpose } from "../security/data-key.ts";
import { purgeRateCounters } from "../security/rate-limit.ts";
import type { TaskDef } from "./tasks.ts";

export const PURGE_CHUNK = 500;
export const RESEAL_CHUNK = 25;
export const PAIR_REQUEST_GRACE_S = 86_400;

/** Columns sealed with data-key.ts; a phase that seals a new column adds a row here. */
export const SEALED_COLUMNS: readonly { table: string; column: string; purpose: SealPurpose }[] = [
  { table: "devices", column: "endpoint_enc", purpose: "device_endpoint" },
  { table: "devices", column: "auth_enc", purpose: "device_auth" },
];
/** Settings rows holding a sealed string. */
export const SEALED_SETTINGS: readonly { key: "vapid_private_key_enc"; purpose: SealPurpose }[] = [
  { key: "vapid_private_key_enc", purpose: "vapid" },
];

const more = (n: number) => ({ more: n >= PURGE_CHUNK });

/**
 * Re-seals one chunk of rows still under the previous key. `done` means nothing is left;
 * `full` means a chunk was full, so another run can make progress.
 */
export async function resealChunk(ctx: AppContext): Promise<{ resealed: number; done: boolean; full: boolean }> {
  if (!ctx.env.DATA_KEY_PREVIOUS) return { resealed: 0, done: true, full: false };
  const ring = await keyRing(ctx);
  let resealed = 0;
  let done = true;
  let full = false;
  for (const { table, column, purpose } of SEALED_COLUMNS) {
    const rows = await all<{ id: string; v: string }>(ctx.db,
      `SELECT id, ${column} AS v FROM ${table} WHERE ${column} IS NOT NULL AND ${column} NOT LIKE ? LIMIT ?`,
      `k${ring.version}.%`, RESEAL_CHUNK);
    if (rows.length === RESEAL_CHUNK) {
      done = false;
      full = true;
    }
    const updates: D1PreparedStatement[] = [];
    for (const row of rows) {
      const aad = { table, column, rowId: row.id };
      try {
        const fresh = await seal(ctx, purpose, aad, await open(ctx, purpose, aad, row.v));
        updates.push(stmt(ctx.db, `UPDATE ${table} SET ${column} = ? WHERE id = ? AND ${column} = ?`, fresh, row.id, row.v));
      } catch (err) {
        if (!(err instanceof DataKeyError)) throw err;
        done = false;
        ctx.log.error("reseal_failed", { table, column, row_id: row.id, error: err.message });
      }
    }
    if (updates.length) resealed += (await batch(ctx.db, updates)).reduce((a, b) => a + b, 0);
  }
  for (const { key, purpose } of SEALED_SETTINGS) {
    const value = await getSetting(ctx.db, key);
    if (value === null || sealedVersion(value) === ring.version) continue;
    const aad = { table: "settings", column: "value", rowId: key };
    try {
      const fresh = await seal(ctx, purpose, aad, await open(ctx, purpose, aad, value));
      if (await compareAndSetSetting(ctx.db, key, value, fresh, ctx.now())) resealed++;
    } catch (err) {
      if (!(err instanceof DataKeyError)) throw err;
      done = false;
      ctx.log.error("reseal_failed", { table: "settings", row_id: key, error: err.message });
    }
  }
  if (done) ctx.log.info("data_key_previous_safe_to_remove", { action: "Every sealed row uses the current DATA_KEY; remove the DATA_KEY_PREVIOUS secret." });
  return { resealed, done, full };
}

export const PURGE_TASKS: readonly TaskDef[] = [
  {
    name: "purge_nonces", intervalS: 600, priority: 50, cost: { queries: 1, subrequests: 0 },
    run: async (ctx) => more(await purgeExpiredNonces(ctx.db, ctx.now(), PURGE_CHUNK)),
  },
  {
    name: "purge_pair_requests", intervalS: 600, priority: 50, cost: { queries: 1, subrequests: 0 },
    run: async (ctx) => more(await run(ctx.db,
      "DELETE FROM pair_requests WHERE id IN (SELECT id FROM pair_requests WHERE expires_at < ? LIMIT ?)",
      ctx.now() - PAIR_REQUEST_GRACE_S, PURGE_CHUNK)),
  },
  {
    name: "purge_audit", intervalS: 86_400, priority: 60, cost: { queries: 2, subrequests: 0 },
    run: async (ctx) => {
      const days = (await getSetting(ctx.db, "audit_retention_days")) ?? 365;
      return more(await purgeAudit(ctx.db, ctx.now(), days, PURGE_CHUNK));
    },
  },
  {
    name: "purge_rate_counters", intervalS: 3_600, priority: 60, cost: { queries: 1, subrequests: 0 },
    run: async (ctx) => {
      await purgeRateCounters(ctx.db, ctx.now());
    },
  },
  {
    name: "reseal_data", intervalS: 3_600, priority: 70, cost: { queries: 12, subrequests: 0 },
    run: async (ctx) => ({ more: (await resealChunk(ctx)).full }),
  },
];
