/**
 * Admin user management over 04's `users` table: list, promote, demote, disable, enable.
 *
 * Demoting or disabling the last active admin is refused with `last_admin`. Disabling with
 * `revoke_all` then tears down every machine (05, reason `user_disabled`), revokes every
 * phone (06) and signs the user out of Access everywhere (06), in that order, so nothing
 * the user owns stays reachable. Each change is audited.
 */
import type { AdminUser, AdminUserPatch } from "@yaran/protocol";
import type { Identity } from "./ports.ts";
import type { Phase07Deps } from "../console/route-types.ts";

interface UserRow {
  id: string;
  email: string;
  role: "user" | "admin";
  status: "active" | "disabled";
  created_at: number;
  last_seen_at: number | null;
  machines: number;
  devices: number;
}

const iso = (s: number | null, fallback: number) => new Date((s ?? fallback) * 1000).toISOString();

export function toAdminUser(r: UserRow): AdminUser {
  return {
    id: r.id,
    email: r.email,
    role: r.role,
    disabled: r.status === "disabled",
    created_at: iso(r.created_at, r.created_at),
    last_seen_at: iso(r.last_seen_at, r.created_at),
    machines: Number(r.machines),
    devices: Number(r.devices),
  };
}

const SELECT = `SELECT u.id, u.email, u.role, u.status, u.created_at, u.last_seen_at,
  (SELECT count(*) FROM machines m WHERE m.owner_user_id = u.id AND m.revoked_at IS NULL) AS machines,
  (SELECT count(*) FROM devices d WHERE d.user_id = u.id AND d.revoked_at IS NULL) AS devices
  FROM users u`;

/** W17: one page ordered by email; the cursor is the last email seen. */
export async function listUsers(deps: Phase07Deps, q: { limit: number; cursor?: string | null; q?: string | null }): Promise<{ items: AdminUser[]; next_cursor: string | null }> {
  const { results } = await deps.db
    .prepare(`${SELECT} WHERE u.email > ? AND (? IS NULL OR instr(u.email, ?) > 0) ORDER BY u.email LIMIT ?`)
    .bind(q.cursor ?? "", q.q ?? null, (q.q ?? "").toLowerCase(), q.limit + 1)
    .all<UserRow>();
  const page = results.slice(0, q.limit).map(toAdminUser);
  return { items: page, next_cursor: results.length > q.limit ? page[page.length - 1]!.email : null };
}

export async function getUser(deps: Phase07Deps, id: string): Promise<AdminUser | null> {
  const row = await deps.db.prepare(`${SELECT} WHERE u.id = ?`).bind(id).first<UserRow>();
  return row ? toAdminUser(row) : null;
}

async function otherActiveAdmins(deps: Phase07Deps, id: string): Promise<number> {
  const row = await deps.db.prepare("SELECT count(*) AS n FROM users WHERE role = 'admin' AND status = 'active' AND id <> ?").bind(id).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

export type PatchOutcome = { ok: true; user: AdminUser } | { ok: false; code: "not_found" | "last_admin" | "validation_failed" };

/** W18: applies an `AdminUserPatch`. */
export async function patchUser(deps: Phase07Deps, actor: Identity, id: string, patch: AdminUserPatch): Promise<PatchOutcome> {
  if (patch.revoke_all && patch.disabled !== true) return { ok: false, code: "validation_failed" };
  const user = await getUser(deps, id);
  if (!user) return { ok: false, code: "not_found" };
  const losesAdmin = user.role === "admin" && !user.disabled && (patch.role === "user" || patch.disabled === true);
  if (losesAdmin && (await otherActiveAdmins(deps, id)) === 0) return { ok: false, code: "last_admin" };
  const who = { kind: "admin" as const, id: actor.user_id };
  const target = { kind: "user" as const, id };
  if (patch.role && patch.role !== user.role) {
    await deps.db.prepare("UPDATE users SET role = ? WHERE id = ?").bind(patch.role, id).run();
    await deps.audit({ actor: who, action: "user.role_changed", target, outcome: "ok", detail: { role: patch.role } });
  }
  if (patch.disabled !== undefined && patch.disabled !== user.disabled) {
    await deps.db.prepare("UPDATE users SET status = ? WHERE id = ?").bind(patch.disabled ? "disabled" : "active", id).run();
    await deps.audit({ actor: who, action: patch.disabled ? "user.disabled" : "user.enabled", target, outcome: "ok", detail: { revoke_all: !!patch.revoke_all } });
  }
  if (patch.disabled && patch.revoke_all) await revokeEverything(deps, user);
  return { ok: true, user: (await getUser(deps, id))! };
}

/** Machines first (05 teardown), then phones (06), then Access sessions (06). */
export async function revokeEverything(deps: Phase07Deps, user: AdminUser): Promise<void> {
  const pairing = deps.pairing;
  const machines = await pairing.listMachines({ owner_user_id: user.id, limit: 100 });
  for (const m of machines.items) await deps.provisioning.startTeardown(m.id, "user_disabled");
  await pairing.revokeAllDevices(user.id);
  await pairing.revokeUserSessions(user.email);
}

/** W19: revokes everything the user owns and disables the account, audited as `user.deleted`. */
export async function deleteUser(deps: Phase07Deps, actor: Identity, id: string): Promise<{ ok: true } | { ok: false; code: "not_found" | "last_admin" }> {
  const user = await getUser(deps, id);
  if (!user) return { ok: false, code: "not_found" };
  if (user.role === "admin" && !user.disabled && (await otherActiveAdmins(deps, id)) === 0) return { ok: false, code: "last_admin" };
  await deps.db.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").bind(id).run();
  await revokeEverything(deps, user);
  await deps.audit({ actor: { kind: "admin", id: actor.user_id }, action: "user.deleted", target: { kind: "user", id }, outcome: "ok" });
  // shortcut: the row stays (disabled) because machine rows reference it until 05's async teardown finishes; purge it from a teardown-done hook when 05 exposes one.
  return { ok: true };
}
