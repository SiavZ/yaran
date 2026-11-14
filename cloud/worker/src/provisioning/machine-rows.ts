/**
 * The `machines` columns the provisioning engine reads and writes (04's table, 05's columns).
 *
 * 04's `db/machines.ts` owns the row and its status transitions for pairing; the Cloudflare
 * columns (resource ids, AUD, hostname, ingress port, tunnel generation, status cache) are
 * written only through `machinePatch` here, which whitelists them by type.
 *
 * - Never writes a tunnel token: there is no column for one.
 * - Guarded status transitions return whether they applied (`meta.changes`).
 *
 * <module-headers:begin>
 * Uses:
 * src/provisioning/machine-rows.ts
 * └── src/provisioning/ports.ts
 * External: none
 *
 * Used by:
 * src/provisioning/machine-rows.ts
 * ├── src/admin/scheduled-jobs.ts
 * ├── src/pairing/sweep.ts
 * ├── src/provisioning/engine.ts
 * ├── src/provisioning/index.ts
 * ├── src/provisioning/ops-store.ts
 * ├── src/provisioning/steps-provision.ts
 * ├── src/provisioning/steps-teardown.ts
 * ├── src/reconcile/drift.ts
 * ├── src/reconcile/status.ts
 * └── test/provisioning/teardown.test.ts
 * <module-headers:end>
 */
import type { D1Like, D1Stmt } from "./ports.ts";

export type MachineStatus = "provisioning" | "awaiting_claim" | "active" | "revoking" | "revoked" | "failed";
export type RevokeReason = "user_unpair" | "admin_revoke" | "machine_logout" | "user_disabled" | "stale" | "provision_failed";

export interface MachineRow {
  id: string;
  instance_id: string;
  owner_user_id: string;
  owner_email: string;
  owner_slug: string;
  name: string;
  slug: string;
  hostname: string | null;
  origin_port: number;
  ingress_origin_port: number | null;
  status: MachineStatus;
  access_policy_id: string | null;
  access_app_id: string | null;
  access_app_aud: string | null;
  tunnel_id: string | null;
  dns_record_id: string | null;
  tunnel_secret_generation: number;
  ingress_version: number | null;
  cf_status: string | null;
  cf_status_at: number | null;
}

/** The columns `machinePatch` may write. */
export interface MachinePatch {
  hostname?: string | null;
  access_policy_id?: string | null;
  access_app_id?: string | null;
  access_app_aud?: string | null;
  tunnel_id?: string | null;
  dns_record_id?: string | null;
  tunnel_secret_generation?: number;
  ingress_version?: number | null;
  ingress_origin_port?: number | null;
  status?: MachineStatus;
  revoke_reason?: RevokeReason;
  revoked_at?: number;
}

const PATCHABLE: ReadonlySet<string> = new Set([
  "hostname",
  "access_policy_id",
  "access_app_id",
  "access_app_aud",
  "tunnel_id",
  "dns_record_id",
  "tunnel_secret_generation",
  "ingress_version",
  "ingress_origin_port",
  "status",
  "revoke_reason",
  "revoked_at",
]);

export const LIVE_STATUSES: readonly MachineStatus[] = ["awaiting_claim", "active"];

export const MACHINE_SELECT = `SELECT m.id, m.instance_id, m.owner_user_id, u.email AS owner_email, u.slug AS owner_slug,
  m.name, m.slug, m.hostname, m.origin_port, m.ingress_origin_port, m.status, m.access_policy_id, m.access_app_id,
  m.access_app_aud, m.tunnel_id, m.dns_record_id, m.tunnel_secret_generation, m.ingress_version, m.cf_status, m.cf_status_at
  FROM machines m JOIN users u ON u.id = m.owner_user_id`;

export function loadMachine(db: D1Like, id: string): Promise<MachineRow | null> {
  return db.prepare(`${MACHINE_SELECT} WHERE m.id = ?`).bind(id).first<MachineRow>();
}

/** One UPDATE for the patched columns, or null when the patch is empty. */
export function machinePatch(db: D1Like, id: string, patch: MachinePatch): D1Stmt | null {
  const keys = Object.keys(patch).filter((k) => PATCHABLE.has(k));
  if (keys.length === 0) return null;
  const values = keys.map((k) => (patch as Record<string, unknown>)[k] ?? null);
  return db
    .prepare(`UPDATE machines SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`)
    .bind(...values, id);
}

/** Resource ids, AUD and hostname cleared: the machine owns nothing in Cloudflare any more. */
export const RELEASED: MachinePatch = {
  hostname: null,
  access_policy_id: null,
  access_app_id: null,
  access_app_aud: null,
  tunnel_id: null,
  dns_record_id: null,
  ingress_version: null,
  ingress_origin_port: null,
};

/** Guarded `provisioning → awaiting_claim`; 06 moves it to `active` at claim. */
export async function markAwaitingClaim(db: D1Like, id: string): Promise<boolean> {
  const r = await db.prepare("UPDATE machines SET status = 'awaiting_claim' WHERE id = ? AND status = 'provisioning'").bind(id).run();
  return r.meta.changes === 1;
}

/** Guarded transition to `revoking` (wire `tearing_down`) from any non-terminal status. */
export function markRevokingStmt(db: D1Like, id: string, reason: RevokeReason, revokedBy: string): D1Stmt {
  return db
    .prepare(
      "UPDATE machines SET status = 'revoking', revoke_reason = ?, revoked_by = ? WHERE id = ? AND status IN ('provisioning','awaiting_claim','active')",
    )
    .bind(reason, revokedBy, id);
}
