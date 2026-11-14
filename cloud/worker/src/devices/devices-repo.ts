/**
 * Devices repository: registration upsert, listing, mutes, revocation and the push
 * delivery outcome Phase 08 reports, over the `devices` table.
 *
 * The endpoint (a capability URL) and the `auth` secret are stored sealed with 04's data
 * key (T55); `p256dh` is public and stored plain. Rows map to 02's `Device` in one mapper,
 * which never carries an endpoint or a key.
 *
 * - The device key is fixed per install: a different key for a known `install_id` is
 *   `409 conflict` and changes nothing (D24).
 * - The per-user cap is checked inside the insert statement, so two concurrent
 *   registrations cannot both pass it.
 * - A push answer never deletes or revokes a device; only revocation hides it, and the
 *   revoked row keeps its `device_key_fingerprint` for the handoff skip rule (02 §8.1).
 *
 * <module-headers:begin>
 * Uses:
 * src/devices/devices-repo.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/devices/device-params.ts
 * ├── src/http/responses.ts
 * ├── src/routes/call.ts
 * └── src/shared/timestamp.ts
 * External: none
 *
 * Used by:
 * src/devices/devices-repo.ts
 * ├── src/me/devices-route.ts
 * └── test/devices/devices-repo.test.ts
 * <module-headers:end>
 */
import { b64urlDecode, b64urlEncode, deviceKeyFingerprint, timingSafeEqual, type Device, type Flavor, type FormFactor, type Platform, type PushChannel, type PushState } from "@yaran/protocol";
import type { Phase06Ctx } from "../routes/call.ts";
import { HttpError } from "../http/responses.ts";
import { type AuditRecord, type FoundationCtx } from "../routes/call.ts";
import { fromTimestamp, toNullableTimestamp, toTimestamp } from "../shared/timestamp.ts";
import type { CheckedRegistration } from "./device-params.ts";

export interface DeviceRow {
  id: string;
  user_id: string;
  install_id: string;
  platform: Platform;
  flavor: Flavor;
  form_factor: FormFactor;
  locale: string | null;
  push_kind: PushChannel | "none";
  push_distributor: string | null;
  endpoint_host: string | null;
  push_vapid_public_key: ArrayBuffer | null;
  device_key: ArrayBuffer;
  device_key_fingerprint: string;
  app_version: string;
  label: string;
  created_at: number;
  last_seen_at: number | null;
  revoked_at: number | null;
  push_state: PushState;
  last_push_ok_at: number | null;
  mute_all: number;
  muted_until: number | null;
  /** JSON array from `device_machine_mutes`, assembled by `DEVICE_COLUMNS`. */
  muted_machine_ids: string;
}

/** Every device column plus the per-machine mutes as a JSON array, in a stable order. */
const DEVICE_COLUMNS = `devices.*, (SELECT json_group_array(machine_id) FROM
  (SELECT machine_id FROM device_machine_mutes WHERE device_id = devices.id ORDER BY machine_id)) AS muted_machine_ids`;

/** Replaces a device's per-machine mutes (Phase 08's `device_machine_mutes` table). */
function setMutesStatements(ctx: FoundationCtx, deviceId: string, machineIds: readonly string[]): D1PreparedStatement[] {
  return [
    ctx.db.prepare("DELETE FROM device_machine_mutes WHERE device_id = ?").bind(deviceId),
    ctx.db.prepare("INSERT INTO device_machine_mutes (device_id, machine_id) SELECT ?, value FROM json_each(?)").bind(deviceId, JSON.stringify(machineIds)),
  ];
}

const endpointAad = (id: string) => ({ table: "devices", column: "endpoint_enc", rowId: id });
const authAad = (id: string) => ({ table: "devices", column: "auth_enc", rowId: id });

const vapidB64 = (raw: ArrayBuffer | null): string | null => (raw === null ? null : b64urlEncode(new Uint8Array(raw)));

/** The one row → 02 `Device` mapper. */
export function toDevice(row: DeviceRow, currentInstallId: string | null): Device {
  const push: Device["push"] =
    row.push_kind === "none"
      ? { kind: "none" }
      : {
          kind: "webpush",
          channel: row.push_kind,
          ...(row.endpoint_host ? { endpoint_host: row.endpoint_host } : {}),
          last_success_at: toNullableTimestamp(row.last_push_ok_at),
          vapid_public_key: vapidB64(row.push_vapid_public_key),
        };
  return {
    id: row.id,
    install_id: row.install_id,
    device_key_fingerprint: row.device_key_fingerprint,
    platform: row.platform,
    flavor: row.flavor,
    form_factor: row.form_factor,
    app_version: row.app_version,
    label: row.label,
    push,
    push_state: row.push_state,
    mute_all: row.mute_all === 1,
    muted_until: toNullableTimestamp(row.muted_until),
    muted_machine_ids: JSON.parse(row.muted_machine_ids) as string[],
    created_at: toTimestamp(row.created_at),
    last_seen_at: toTimestamp(row.last_seen_at ?? row.created_at),
    current: row.install_id === currentInstallId,
  };
}

/** True when every id is a machine the user owns (an empty list passes). */
export async function ownsMachines(ctx: FoundationCtx, userId: string, ids: readonly string[]): Promise<boolean> {
  if (ids.length === 0) return true;
  const r = await ctx.db
    .prepare("SELECT count(*) AS n FROM machines WHERE owner_user_id = ? AND id IN (SELECT value FROM json_each(?))")
    .bind(userId, JSON.stringify(ids))
    .first<{ n: number }>();
  return r?.n === ids.length;
}

export function getOwnedDevice(ctx: FoundationCtx, id: string, userId: string): Promise<DeviceRow | null> {
  return ctx.db.prepare(`SELECT ${DEVICE_COLUMNS} FROM devices WHERE id = ? AND user_id = ? AND revoked_at IS NULL`).bind(id, userId).first<DeviceRow>();
}

const byInstall = (ctx: FoundationCtx, userId: string, installId: string) =>
  ctx.db.prepare(`SELECT ${DEVICE_COLUMNS} FROM devices WHERE user_id = ? AND install_id = ?`).bind(userId, installId).first<DeviceRow>();

/** Registers or updates the install's device; `created` decides 201 vs 200. */
export async function upsertDevice(ctx: Phase06Ctx, userId: string, c: CheckedRegistration): Promise<{ row: DeviceRow; created: boolean }> {
  const { reg } = c;
  if (!(await ownsMachines(ctx, userId, reg.muted_machine_ids))) {
    throw new HttpError("validation_failed", "muted_machine_ids names a machine that is not yours.", { details: { errors: [{ path: "/muted_machine_ids", message: "unknown machine" }] } });
  }
  const internal = await ctx.settings.internal();
  const existing = await byInstall(ctx, userId, reg.install_id);
  const id = existing?.id ?? crypto.randomUUID();
  if (existing) {
    if (existing.revoked_at !== null) throw new HttpError("device_revoked", "This phone was removed from the org. Sign in again to add it back.");
    if (!timingSafeEqual(new Uint8Array(existing.device_key), c.deviceKey)) {
      throw new HttpError("conflict", "This install is already registered with a different device key. Remove the org from the app and add it again.");
    }
  }
  const p = c.push;
  const fields = [
    reg.platform, reg.flavor, reg.form_factor, reg.locale ?? null,
    p?.channel ?? "none", p?.distributor ?? null,
    p ? await ctx.dataKey.seal("device_endpoint", endpointAad(id), p.endpoint) : null,
    p?.endpointHost ?? null, p?.p256dh ?? null,
    p ? await ctx.dataKey.seal("device_auth", authAad(id), p.auth) : null,
    p && internal.vapidPublicKey ? b64urlDecode(internal.vapidPublicKey) : null,
    reg.app_version, reg.label, p ? "active" : "none",
    reg.mute_all ? 1 : 0, reg.muted_until === null ? null : fromTimestamp(reg.muted_until),
  ];
  if (existing) {
    await ctx.db
      .prepare(
        `UPDATE devices SET platform = ?, flavor = ?, form_factor = ?, locale = ?, push_kind = ?, push_distributor = ?, endpoint_enc = ?,
           endpoint_host = ?, p256dh = ?, auth_enc = ?, push_vapid_public_key = ?, app_version = ?, label = ?, push_state = ?,
           mute_all = ?, muted_until = ?
         WHERE id = ? AND revoked_at IS NULL`,
      )
      .bind(...fields, id)
      .run();
    await ctx.db.batch(setMutesStatements(ctx, id, reg.muted_machine_ids));
    return { row: (await byInstall(ctx, userId, reg.install_id))!, created: false };
  }
  const cap = (await ctx.settings.read()).device_cap_per_user;
  const ins = await ctx.db
    .prepare(
      `INSERT OR IGNORE INTO devices (platform, flavor, form_factor, locale, push_kind, push_distributor, endpoint_enc, endpoint_host, p256dh,
         auth_enc, push_vapid_public_key, app_version, label, push_state, mute_all, muted_until,
         id, user_id, install_id, device_key, device_key_fingerprint, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE (SELECT count(*) FROM devices WHERE user_id = ? AND revoked_at IS NULL) < ?`,
    )
    .bind(...fields, id, userId, reg.install_id, c.deviceKey, await deviceKeyFingerprint(reg.device_key), ctx.now(), userId, cap)
    .run();
  if (ins.meta.changes === 1) {
    await ctx.db.batch(setMutesStatements(ctx, id, reg.muted_machine_ids));
    return { row: (await byInstall(ctx, userId, reg.install_id))!, created: true };
  }
  // A concurrent registration of the same install won the insert: answer as its update.
  if (await byInstall(ctx, userId, reg.install_id)) return upsertDevice(ctx, userId, c);
  await ctx.audit.record({ action: "device.cap_refused", actor: { kind: "user", id: userId }, target: { kind: "user", id: userId }, outcome: "denied", errorCode: "device_cap_reached", detail: { limit: cap } });
  throw new HttpError("device_cap_reached", `You already have ${cap} phones registered with this org. Remove one in the console before adding another.`, { details: { limit: cap } });
}

/** One page of the user's devices (revoked ones never listed), oldest first. */
export async function listDevices(ctx: FoundationCtx, userId: string, limit: number, after: { createdAt: number; id: string } | null): Promise<DeviceRow[]> {
  const r = await ctx.db
    .prepare(
      `SELECT ${DEVICE_COLUMNS} FROM devices WHERE user_id = ? AND revoked_at IS NULL
         AND (? IS NULL OR created_at > ? OR (created_at = ? AND id > ?))
       ORDER BY created_at, id LIMIT ?`,
    )
    .bind(userId, after?.createdAt ?? null, after?.createdAt ?? 0, after?.createdAt ?? 0, after?.id ?? "", limit)
    .all<DeviceRow>();
  return r.results;
}

/** Applies a validated `DevicePatch` to the user's device; null for another user's id. */
export async function patchDevice(
  ctx: FoundationCtx,
  id: string,
  userId: string,
  patch: { label?: string; mute_all?: boolean; muted_until?: string | null; muted_machine_ids?: string[] },
): Promise<DeviceRow | null> {
  const row = await getOwnedDevice(ctx, id, userId);
  if (!row) return null;
  if (patch.muted_machine_ids && !(await ownsMachines(ctx, userId, patch.muted_machine_ids))) {
    throw new HttpError("validation_failed", "muted_machine_ids names a machine that is not yours.", { details: { errors: [{ path: "/muted_machine_ids", message: "unknown machine" }] } });
  }
  const update = ctx.db
    .prepare("UPDATE devices SET label = ?, mute_all = ?, muted_until = ? WHERE id = ? AND revoked_at IS NULL")
    .bind(
      patch.label ?? row.label,
      patch.mute_all === undefined ? row.mute_all : patch.mute_all ? 1 : 0,
      patch.muted_until === undefined ? row.muted_until : patch.muted_until === null ? null : fromTimestamp(patch.muted_until),
      id,
    );
  await ctx.db.batch([update, ...(patch.muted_machine_ids === undefined ? [] : setMutesStatements(ctx, id, patch.muted_machine_ids))]);
  return getOwnedDevice(ctx, id, userId);
}

const CLEAR_PUSH = "endpoint_enc = NULL, endpoint_host = NULL, p256dh = NULL, auth_enc = NULL";

/**
 * Revokes a device: push stops at once, the row leaves every list, the fingerprint stays.
 * `ownerUserId` scopes the user route (W14); 07's admin route (W24) passes null.
 * Returns false when no live device matched.
 */
export async function revokeDevice(
  ctx: FoundationCtx,
  id: string,
  o: { ownerUserId: string | null; actor: AuditRecord["actor"]; signOutEverywhere: boolean },
): Promise<boolean> {
  const r = await ctx.db
    .prepare(`UPDATE devices SET ${CLEAR_PUSH}, push_state = 'none', revoked_at = ?, revoked_by = ? WHERE id = ? AND revoked_at IS NULL AND (? IS NULL OR user_id = ?)`)
    .bind(ctx.now(), o.actor.id ?? o.actor.kind, id, o.ownerUserId, o.ownerUserId)
    .run();
  if (r.meta.changes !== 1) return false;
  await ctx.audit.record({ action: "device.revoked", actor: o.actor, target: { kind: "device", id }, outcome: "ok", detail: { sign_out_everywhere: o.signOutEverywhere } });
  return true;
}

/** 02 §9 delivery outcomes, as Phase 08 classifies a push service answer. */
export type PushOutcome =
  | { kind: "delivered" }
  | { kind: "gone"; errorCode: string }
  | { kind: "auth_failed"; errorCode: string }
  | { kind: "failing"; errorCode: string };

/** Records a delivery outcome (Phase 08's entry point); never deletes or revokes the row. */
export async function setPushOutcome(ctx: FoundationCtx, deviceId: string, outcome: PushOutcome): Promise<void> {
  const k = outcome.kind;
  let sql: string;
  let binds: unknown[];
  switch (k) {
    case "delivered":
      sql = "UPDATE devices SET push_state = 'active', last_push_ok_at = ? WHERE id = ? AND revoked_at IS NULL AND push_kind <> 'none'";
      binds = [ctx.now(), deviceId];
      break;
    case "gone":
      sql = `UPDATE devices SET ${CLEAR_PUSH}, push_state = 'gone' WHERE id = ? AND revoked_at IS NULL`;
      binds = [deviceId];
      break;
    case "auth_failed":
    case "failing":
      sql = "UPDATE devices SET push_state = ? WHERE id = ? AND revoked_at IS NULL";
      binds = [k, deviceId];
      break;
    default: {
      const never: never = k;
      throw new Error(`unhandled push outcome ${String(never)}`);
    }
  }
  await ctx.db.prepare(sql).bind(...binds).run();
}
