/**
 * The consoles' view of machines and phones, built on Phase 06's repositories and view
 * models and 05's op state: the real `PairingPort`.
 *
 * - Lists page by (created_at, id) with 06's opaque cursor; revoked rows are never listed.
 * - A machine's provisioning state is its live op's (05), else `complete`.
 * - Removing a phone and revoking sessions reuse 06's code paths, audits included.
 *
 * <module-headers:begin>
 * Uses:
 * src/admin/pairing-service.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/admin/ports.ts
 * ├── src/cloudflare/access-sessions.ts
 * ├── src/devices/devices-repo.ts
 * ├── src/machines/machine-rows.ts
 * ├── src/machines/machine-view-model.ts
 * ├── src/me/cursor.ts
 * ├── src/me/machines-route.ts
 * ├── src/pairing/qr.ts
 * ├── src/provisioning/index.ts
 * ├── src/provisioning/ops-store.ts
 * └── src/routes/call.ts
 * External: none
 *
 * Used by:
 * src/admin/pairing-service.ts
 * └── src/routes/phase07-context.ts
 * <module-headers:end>
 */
import type { AdminDevice, AdminDevicePage, AdminMachine, AdminMachinePage, ErrorCode } from "@yaran/protocol";
import { revokeUserSessions } from "../cloudflare/access-sessions.ts";
import { revokeDevice, toDevice, type DeviceRow } from "../devices/devices-repo.ts";
import type { MachineRow } from "../machines/machine-rows.ts";
import { adminMachine } from "../machines/machine-view-model.ts";
import { decodeCursor, nextCursor } from "../me/cursor.ts";
import { unpairOwnedMachine } from "../me/machines-route.ts";
import { phoneQrSvg } from "../pairing/qr.ts";
import { liveOpFor } from "../provisioning/ops-store.ts";
import { wireState } from "../provisioning/index.ts";
import type { AuditRecord, Phase06Ctx } from "../routes/call.ts";
import type { PairingPort } from "./ports.ts";

const DEVICE_COLUMNS = `devices.*, users.email AS owner_email, (SELECT json_group_array(machine_id) FROM
  (SELECT machine_id FROM device_machine_mutes WHERE device_id = devices.id ORDER BY machine_id)) AS muted_machine_ids`;

type OwnedMachine = MachineRow & { owner_email: string };
type OwnedDevice = DeviceRow & { owner_email: string };

function page(q: { owner_user_id?: string; cursor?: string | null }) {
  const after = q.cursor ? decodeCursor(q.cursor) : null;
  return [q.owner_user_id ?? null, q.owner_user_id ?? null, after?.createdAt ?? null, after?.createdAt ?? 0, after?.createdAt ?? 0, after?.id ?? ""];
}

const PAGE_FILTER = `(? IS NULL OR owner = ?) AND (? IS NULL OR created_at > ? OR (created_at = ? AND id > ?))`;

/** `actor` is who removes phones through it (the signed-in admin, or the system). */
export function pairingService(ctx: Phase06Ctx, actor: AuditRecord["actor"] = { kind: "system", id: null }): PairingPort {
  const toAdmin = async (row: OwnedMachine): Promise<AdminMachine | null> => {
    const op = await liveOpFor(ctx.db, row.id);
    return adminMachine(row, row.owner_email, op ? { state: wireState(op.state), errorCode: op.last_error_code as ErrorCode | null } : null, ctx.now());
  };
  const toAdminDevice = (row: OwnedDevice): AdminDevice => ({ ...toDevice(row, null), owner_email: row.owner_email });
  const machineQuery = `SELECT * FROM (SELECT machines.*, machines.owner_user_id AS owner, users.email AS owner_email
    FROM machines JOIN users ON users.id = machines.owner_user_id WHERE machines.status <> 'revoked')`;
  const deviceQuery = `SELECT * FROM (SELECT ${DEVICE_COLUMNS}, devices.user_id AS owner
    FROM devices JOIN users ON users.id = devices.user_id WHERE devices.revoked_at IS NULL)`;

  return {
    async listMachines(q): Promise<AdminMachinePage> {
      const rows = (await ctx.db.prepare(`${machineQuery} WHERE ${PAGE_FILTER} ORDER BY created_at, id LIMIT ?`).bind(...page(q), q.limit).all<OwnedMachine>()).results;
      const items = (await Promise.all(rows.map(toAdmin))).filter((m): m is AdminMachine => m !== null);
      return { items, next_cursor: nextCursor(rows, q.limit) };
    },
    async listDevices(q): Promise<AdminDevicePage> {
      const rows = (await ctx.db.prepare(`${deviceQuery} WHERE ${PAGE_FILTER} ORDER BY created_at, id LIMIT ?`).bind(...page(q), q.limit).all<OwnedDevice>()).results;
      return { items: rows.map(toAdminDevice), next_cursor: nextCursor(rows, q.limit) };
    },
    async getMachine(id) {
      const row = await ctx.db.prepare(`${machineQuery} WHERE id = ?`).bind(id).first<OwnedMachine>();
      return row ? toAdmin(row) : null;
    },
    async getDevice(id) {
      const row = await ctx.db.prepare(`${deviceQuery} WHERE id = ?`).bind(id).first<OwnedDevice>();
      return row ? toAdminDevice(row) : null;
    },
    unpairMachine: async (userId, machineId) => ((await unpairOwnedMachine(ctx, userId, machineId)) ? "started" : "gone"),
    async revokeDevice(deviceId, o) {
      const row = await ctx.db.prepare("SELECT users.email AS email FROM devices JOIN users ON users.id = devices.user_id WHERE devices.id = ?").bind(deviceId).first<{ email: string }>();
      const done = await revokeDevice(ctx, deviceId, { ownerUserId: null, actor, signOutEverywhere: o.signOutEverywhere });
      if (done && o.signOutEverywhere && row) await revokeUserSessions(ctx, row.email);
      return done ? "revoked" : "gone";
    },
    async revokeAllDevices(userId) {
      const ids = (await ctx.db.prepare("SELECT id FROM devices WHERE user_id = ? AND revoked_at IS NULL").bind(userId).all<{ id: string }>()).results;
      for (const { id } of ids) await revokeDevice(ctx, id, { ownerUserId: userId, actor, signOutEverywhere: false });
    },
    revokeUserSessions: (email) => revokeUserSessions(ctx, email),
    phoneQrSvg,
  };
}
