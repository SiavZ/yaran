/**
 * The JSON admin API, 02 W17–W27 (`/v1/admin/*`), auth class `admin`.
 *
 * The same service functions as the admin console, behind JSON: bodies are validated with
 * 02's validators before anything runs, refusals use 02's registry codes in the error
 * envelope, and mutating requests must be `application/json` from this origin (04's
 * pipeline enforces that too; it is checked here as well so these rows are safe alone).
 * W28 (reconcile) is 05's.
 *
 * <module-headers:begin>
 * Uses:
 * src/admin-api/routes.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/admin/audit-query.ts
 * ├── src/admin/settings-apply.ts
 * ├── src/admin/settings-schema.ts
 * ├── src/admin/users.ts
 * ├── src/console/route-types.ts
 * ├── src/console/ui/security-headers.ts
 * └── src/update/update-checker.ts
 * External: none
 *
 * Used by:
 * src/admin-api/routes.ts
 * ├── src/phase07.ts
 * └── test/console.test.ts
 * <module-headers:end>
 */
import { buildErrorEnvelope, validate, type AdminUserPatch, type ErrorCode, type Settings } from "@yaran/protocol";
import { queryAudit } from "../admin/audit-query.ts";
import { saveSettings } from "../admin/settings-apply.ts";
import { readSettings } from "../admin/settings-schema.ts";
import { deleteUser, listUsers, patchUser } from "../admin/users.ts";
import { jsonRequestCheck, securityHeaders } from "../console/ui/security-headers.ts";
import type { RouteCtx, RouteRow } from "../console/route-types.ts";
import { readUpdateStatus } from "../update/update-checker.ts";

const admin = { kind: "admin" } as const;

function json(body: unknown, status = 200): Response {
  return new Response(body === null ? null : JSON.stringify(body), { status, headers: { ...securityHeaders(), "Content-Type": "application/json" } });
}

export function jsonError(ctx: RouteCtx, code: ErrorCode, message: string, details?: Record<string, unknown>): Response {
  const { status, body } = buildErrorEnvelope(code, message, ctx.requestId, details);
  return json(body, status);
}

/** Parses `limit` (1–100, default 50) and `cursor`; null when `limit` is out of range. */
function paging(ctx: RouteCtx): { limit: number; cursor: string | null } | null {
  const raw = ctx.url.searchParams.get("limit");
  const limit = raw === null ? 50 : Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return null;
  return { limit, cursor: ctx.url.searchParams.get("cursor") };
}

async function readJson(ctx: RouteCtx): Promise<unknown> {
  try {
    return await ctx.request.json();
  } catch {
    return undefined;
  }
}

function validationFailed(ctx: RouteCtx, errors: { path: string; message: string }[]): Response {
  return jsonError(ctx, "validation_failed", "The request body does not match the schema.", { errors: errors.slice(0, 20) });
}

/** Wraps a handler with the JSON content-type and Origin rule. */
function route(method: RouteRow["method"], path: string, handler: (ctx: RouteCtx) => Promise<Response>): RouteRow {
  return {
    method,
    path,
    auth: admin,
    kind: "json",
    async handler(ctx) {
      const check = jsonRequestCheck(ctx.request, ctx.url.origin);
      if (check === "origin_mismatch") return jsonError(ctx, "origin_mismatch", "The request came from another origin.");
      if (check === "unsupported_media_type") return jsonError(ctx, "unsupported_media_type", "Send the body as application/json.");
      return handler(ctx);
    },
  };
}

async function ownerId(ctx: RouteCtx): Promise<string | undefined> {
  const owner = ctx.url.searchParams.get("owner");
  if (!owner) return undefined;
  if (!owner.includes("@")) return owner;
  const row = await ctx.deps.db.prepare("SELECT id FROM users WHERE email = ?").bind(owner.toLowerCase()).first<{ id: string }>();
  return row?.id ?? "-";
}

const badLimit = (ctx: RouteCtx) => validationFailed(ctx, [{ path: "/limit", message: "limit must be an integer from 1 to 100" }]);

export const ADMIN_API_ROUTES: readonly RouteRow[] = [
  route("GET", "/v1/admin/users", async (ctx) => {
    const p = paging(ctx);
    return p ? json(await listUsers(ctx.deps, { ...p, q: ctx.url.searchParams.get("q") })) : badLimit(ctx);
  }),
  route("PATCH", "/v1/admin/users/:id", async (ctx) => {
    const body = await readJson(ctx);
    const v = validate("AdminUserPatch", body);
    if (!v.valid) return validationFailed(ctx, v.errors);
    const out = await patchUser(ctx.deps, ctx.identity!, ctx.params.id!, body as AdminUserPatch);
    if (out.ok) return json(out.user);
    if (out.code === "last_admin") return jsonError(ctx, "last_admin", "That would leave the org with no active admin; promote someone else first.");
    if (out.code === "not_found") return jsonError(ctx, "not_found", "No such user.");
    return validationFailed(ctx, [{ path: "/revoke_all", message: "revoke_all is allowed only with disabled: true" }]);
  }),
  route("DELETE", "/v1/admin/users/:id", async (ctx) => {
    const out = await deleteUser(ctx.deps, ctx.identity!, ctx.params.id!);
    if (out.ok) return json(null, 202);
    return out.code === "last_admin" ? jsonError(ctx, "last_admin", "That would leave the org with no active admin.") : jsonError(ctx, "not_found", "No such user.");
  }),
  route("GET", "/v1/admin/machines", async (ctx) => {
    const p = paging(ctx);
    if (!p) return badLimit(ctx);
    const owner = await ownerId(ctx);
    return json(await ctx.deps.pairing.listMachines({ ...p, ...(owner ? { owner_user_id: owner } : {}) }));
  }),
  route("DELETE", "/v1/admin/machines/:id", async (ctx) => {
    const m = await ctx.deps.pairing.getMachine(ctx.params.id!);
    if (!m) return jsonError(ctx, "not_found", "No such machine.");
    await ctx.deps.provisioning.startTeardown(m.id, "admin_revoke");
    await ctx.deps.audit({ actor: { kind: "admin", id: ctx.identity!.user_id }, action: "machine.revoked", target: { kind: "machine", id: m.id }, outcome: "ok" });
    return json({ machine_id: m.id, state: "tearing_down" }, 202);
  }),
  route("POST", "/v1/admin/machines/:id/rotate", async (ctx) => {
    const body = await readJson(ctx);
    const v = validate("AdminRotateRequest", body);
    if (!v.valid) return validationFailed(ctx, v.errors);
    const m = await ctx.deps.pairing.getMachine(ctx.params.id!);
    if (!m) return jsonError(ctx, "not_found", "No such machine.");
    const evict = (body as { kill_connections: boolean }).kill_connections;
    await ctx.deps.provisioning.rotateTunnelSecret(m.id, { evict });
    await ctx.deps.audit({ actor: { kind: "admin", id: ctx.identity!.user_id }, action: "machine.rotated", target: { kind: "machine", id: m.id }, outcome: "ok", detail: { kill_connections: evict } });
    return json(null, 202);
  }),
  route("GET", "/v1/admin/devices", async (ctx) => {
    const p = paging(ctx);
    if (!p) return badLimit(ctx);
    const owner = await ownerId(ctx);
    return json(await ctx.deps.pairing.listDevices({ ...p, ...(owner ? { owner_user_id: owner } : {}) }));
  }),
  route("DELETE", "/v1/admin/devices/:id", async (ctx) => {
    const out = await ctx.deps.pairing.revokeDevice(ctx.params.id!, { signOutEverywhere: false });
    return out === "gone" ? jsonError(ctx, "not_found", "No such phone.") : json(null, 204);
  }),
  route("GET", "/v1/admin/audit", async (ctx) => {
    const p = paging(ctx);
    if (!p) return badLimit(ctx);
    const q = (k: string) => ctx.url.searchParams.get(k);
    return json(await queryAudit(ctx.deps.db, { actor: q("actor"), action: q("action"), target: q("target"), since: q("since"), until: q("until") }, p.limit, p.cursor));
  }),
  route("GET", "/v1/admin/settings", async (ctx) => json(await readSettings(ctx.deps.db))),
  route("PUT", "/v1/admin/settings", async (ctx) => {
    const out = await saveSettings(ctx.deps, ctx.identity!, await readJson(ctx));
    if (!out.ok) return validationFailed(ctx, out.errors);
    const settings: Settings = await readSettings(ctx.deps.db);
    return json(settings);
  }),
  route("GET", "/v1/admin/update-status", async (ctx) => json(await readUpdateStatus(ctx.deps))),
];
