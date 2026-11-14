/**
 * The `machines` reads and writes Phase 06 needs: the row shape, owner-scoped reads,
 * the live-machine count behind the per-user cap, and the claim-time transitions.
 *
 * 04's `db/machines.ts` owns the table and 05 writes the Cloudflare columns; this module
 * holds only Phase 06's own queries, each a single statement, transitions guarded by
 * their expected status and checked through `meta.changes`.
 *
 * <module-headers:begin>
 * Uses:
 * src/machines/machine-rows.ts
 * └── src/routes/call.ts
 * External: none
 *
 * Used by:
 * src/machines/machine-rows.ts
 * ├── src/machine-api/claim.ts
 * ├── src/machine-api/config.ts
 * ├── src/machine-api/origin.ts
 * ├── src/machines/machine-view-model.ts
 * ├── src/me/machines-route.ts
 * ├── src/me/me-route.ts
 * ├── src/pairing/authorize-route.ts
 * ├── src/pairing/sweep.ts
 * └── test/machines/machine-view-model.test.ts
 * <module-headers:end>
 */
import type { FoundationCtx } from "../routes/call.ts";

export type MachineRowStatus = "provisioning" | "awaiting_claim" | "active" | "revoking" | "revoked" | "failed";
export type CfStatus = "inactive" | "degraded" | "healthy" | "down" | "unknown";

export interface MachineRow {
  id: string;
  owner_user_id: string;
  name: string;
  slug: string;
  hostname: string | null;
  public_key: ArrayBuffer;
  origin_port: number;
  yaran_version: string | null;
  reported_protocol: number | null;
  status: MachineRowStatus;
  access_app_id: string | null;
  access_app_aud: string | null;
  tunnel_id: string | null;
  tunnel_secret_generation: number;
  cf_status: CfStatus | null;
  cf_status_at: number | null;
  conns_active_at: string | null;
  conns_inactive_at: string | null;
  created_at: number;
  claimed_at: number | null;
  last_seen_at: number | null;
  replaced_by: string | null;
}

/** Statuses that count against `Settings.machine_cap_per_user`. */
export const LIVE_STATUSES = ["provisioning", "awaiting_claim", "active"] as const;
const LIVE_SQL = "('provisioning','awaiting_claim','active')";

export function getMachine(ctx: FoundationCtx, id: string): Promise<MachineRow | null> {
  return ctx.db.prepare("SELECT * FROM machines WHERE id = ?").bind(id).first<MachineRow>();
}

/** The caller's own machine; null for another user's id, so ids cannot be probed (T34). */
export function getOwnedMachine(ctx: FoundationCtx, id: string, userId: string): Promise<MachineRow | null> {
  return ctx.db.prepare("SELECT * FROM machines WHERE id = ? AND owner_user_id = ?").bind(id, userId).first<MachineRow>();
}

export async function countLiveMachines(ctx: FoundationCtx, userId: string): Promise<number> {
  const r = await ctx.db.prepare(`SELECT count(*) AS n FROM machines WHERE owner_user_id = ? AND status IN ${LIVE_SQL}`).bind(userId).first<{ n: number }>();
  return r?.n ?? 0;
}

/** Names of the user's live machines (for the same-name branch and the next free name). */
export async function liveMachineNames(ctx: FoundationCtx, userId: string): Promise<{ id: string; name: string; status: MachineRowStatus }[]> {
  const r = await ctx.db
    .prepare(`SELECT id, name, status FROM machines WHERE owner_user_id = ? AND status IN ${LIVE_SQL}`)
    .bind(userId)
    .all<{ id: string; name: string; status: MachineRowStatus }>();
  return r.results;
}

/** One page of the user's listed (non-revoked) machines, oldest first, keyed by (created_at, id). */
export async function listOwnedMachines(
  ctx: FoundationCtx,
  userId: string,
  limit: number,
  after: { createdAt: number; id: string } | null,
): Promise<MachineRow[]> {
  const r = await ctx.db
    .prepare(
      `SELECT * FROM machines WHERE owner_user_id = ? AND status <> 'revoked'
         AND (? IS NULL OR created_at > ? OR (created_at = ? AND id > ?))
       ORDER BY created_at, id LIMIT ?`,
    )
    .bind(userId, after?.createdAt ?? null, after?.createdAt ?? 0, after?.createdAt ?? 0, after?.id ?? "", limit)
    .all<MachineRow>();
  return r.results;
}

export interface NewMachine {
  id: string;
  ownerUserId: string;
  name: string;
  publicKey: Uint8Array;
  originPort: number;
  yaranVersion: string;
  /** A machine being replaced does not count against the cap. */
  excludeFromCap: string | null;
  cap: number;
}

/**
 * Inserts the `provisioning` row only while the owner is under the cap, in one
 * statement so two concurrent approvals cannot both pass (the cap's atomic check).
 * Returns false when the cap refused it; an existing row with this id counts as success.
 */
export async function insertProvisioningMachine(ctx: FoundationCtx, m: NewMachine): Promise<boolean> {
  const exists = await getMachine(ctx, m.id);
  if (exists) return true;
  const r = await ctx.db
    .prepare(
      `INSERT OR IGNORE INTO machines (id, instance_id, owner_user_id, name, slug, public_key, origin_port, yaran_version, status, created_at)
       SELECT ?, coalesce((SELECT json_extract(value, '$') FROM settings WHERE key = 'instance_id'), 'unset'), ?, ?, ?, ?, ?, ?, 'provisioning', ?
       WHERE (SELECT count(*) FROM machines WHERE owner_user_id = ? AND status IN ${LIVE_SQL} AND id IS NOT ?) < ?`,
    )
    .bind(m.id, m.ownerUserId, m.name, m.name, m.publicKey, m.originPort, m.yaranVersion, ctx.now(), m.ownerUserId, m.excludeFromCap, m.cap)
    .run();
  return r.meta.changes === 1;
}

/** awaiting_claim → active at claim, recording what the claim reported. */
export async function activateClaimed(ctx: FoundationCtx, id: string, o: { yaranVersion: string; originPort: number; protocol: number }): Promise<boolean> {
  const r = await ctx.db
    .prepare(
      `UPDATE machines SET status = 'active', claimed_at = ?, last_seen_at = ?, yaran_version = ?, origin_port = ?, reported_protocol = ?
       WHERE id = ? AND status = 'awaiting_claim'`,
    )
    .bind(ctx.now(), ctx.now(), o.yaranVersion, o.originPort, o.protocol, id)
    .run();
  return r.meta.changes === 1;
}

export async function markReplaced(ctx: FoundationCtx, oldId: string, newId: string): Promise<void> {
  await ctx.db.prepare("UPDATE machines SET replaced_by = ? WHERE id = ?").bind(newId, oldId).run();
}
