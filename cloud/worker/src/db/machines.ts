/**
 * The `machines` repository: reads, creation, and every status transition as a named
 * function with a guarded `UPDATE … WHERE status IN (…)`, so two racing transitions cannot
 * both win (each returns whether it applied).
 *
 * Status lifecycle: provisioning → awaiting_claim → active → revoking → revoked, with
 * failed reachable before activation. The Cloudflare columns are written by Phase 05, the
 * claim columns by Phase 06; the wire `MachineSummary.status` is derived by 06 (internal
 * `revoking` is wire `tearing_down`).
 *
 * <module-headers:begin>
 * Uses:
 * src/db/machines.ts
 * └── src/db/client.ts
 * External: none
 *
 * Used by:
 * src/db/machines.ts
 * ├── src/auth/machine-signature.ts
 * ├── src/http/context.ts
 * ├── test/helpers/seed.ts
 * ├── test/machine-signature.test.ts
 * └── test/settings.test.ts
 * <module-headers:end>
 */
import { blob, one, run } from "./client.ts";

export type MachineStatus = "provisioning" | "awaiting_claim" | "active" | "revoking" | "revoked" | "failed";
export type RevokeReason = "user_unpair" | "admin_revoke" | "machine_logout" | "user_disabled" | "stale" | "provision_failed";

export interface MachineRow {
  id: string;
  instance_id: string;
  owner_user_id: string;
  name: string;
  slug: string;
  hostname: string | null;
  public_key: Uint8Array;
  origin_port: number;
  status: MachineStatus;
  reported_protocol: number | null;
  last_seen_at: number | null;
  created_at: number;
  claimed_at: number | null;
  revoked_at: number | null;
  revoked_by: string | null;
  revoke_reason: RevokeReason | null;
  [column: string]: unknown;
}

/** last_seen_at and reported_protocol are written at most once per this many seconds. */
export const MACHINE_SEEN_THROTTLE_S = 60;

export async function getMachine(db: D1Database, id: string): Promise<MachineRow | null> {
  const row = await one<MachineRow>(db, "SELECT * FROM machines WHERE id = ?", id);
  return row ? { ...row, public_key: blob(row.public_key) } : null;
}

export interface NewMachine {
  id: string;
  instanceId: string;
  ownerUserId: string;
  name: string;
  slug: string;
  hostname: string;
  publicKey: Uint8Array;
  originPort: number;
  now: number;
}

/** Creates a machine in `provisioning`. False when the id or hostname is taken. */
export async function insertMachine(db: D1Database, m: NewMachine): Promise<boolean> {
  return (await run(db,
    `INSERT OR IGNORE INTO machines (id, instance_id, owner_user_id, name, slug, hostname, public_key, origin_port, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'provisioning', ?)`,
    m.id, m.instanceId, m.ownerUserId, m.name, m.slug, m.hostname, m.publicKey, m.originPort, m.now)) === 1;
}

const transition = async (db: D1Database, id: string, from: MachineStatus[], set: string, ...params: (string | number | null)[]) =>
  (await run(db,
    `UPDATE machines SET ${set} WHERE id = ? AND status IN (${from.map(() => "?").join(",")})`,
    ...params, id, ...from)) === 1;

export const markAwaitingClaim = (db: D1Database, id: string) =>
  transition(db, id, ["provisioning"], "status = 'awaiting_claim'");

export const markActive = (db: D1Database, id: string, now: number) =>
  transition(db, id, ["awaiting_claim"], "status = 'active', claimed_at = ?", now);

export const markFailed = (db: D1Database, id: string) =>
  transition(db, id, ["provisioning", "awaiting_claim"], "status = 'failed'");

export const beginRevoke = (db: D1Database, id: string, by: string, reason: RevokeReason) =>
  transition(db, id, ["provisioning", "awaiting_claim", "active", "failed"],
    "status = 'revoking', revoked_by = ?, revoke_reason = ?", by, reason);

/** Final step: the hostname is released so a new pairing can reuse it. */
export const markRevoked = (db: D1Database, id: string, now: number) =>
  transition(db, id, ["revoking"], "status = 'revoked', revoked_at = ?, hostname = NULL", now);

/** Stamps last_seen_at and reported_protocol, at most once a minute unless the protocol changed. */
export async function touchMachineSeen(db: D1Database, id: string, protocol: number, now: number): Promise<boolean> {
  return (await run(db,
    `UPDATE machines SET last_seen_at = ?, reported_protocol = ?
     WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at <= ? OR reported_protocol IS NOT ?)`,
    now, protocol, id, now - MACHINE_SEEN_THROTTLE_S, protocol)) === 1;
}
