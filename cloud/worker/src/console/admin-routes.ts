/**
 * The admin console's routes (02 W30 `/admin/*`), auth class `admin`.
 *
 * Thin adapters: each handler calls the same service functions the JSON admin API calls
 * (`admin/*` here, 05's facade, 06's views) and renders the result. Destructive actions are
 * GET confirm + POST act; every outcome is a flash naming the target; every change is
 * audited (by the service, or here where the service is another phase's).
 *
 * <module-headers:begin>
 * Uses:
 * src/console/admin-routes.ts
 * ├── src/admin/api-token.ts
 * ├── src/admin/audit-query.ts
 * ├── src/admin/health.ts
 * ├── src/admin/settings-apply.ts
 * ├── src/admin/settings-schema.ts
 * ├── src/admin/settings-store.ts
 * ├── src/admin/users.ts
 * ├── src/console/admin-pages-2.tsx
 * ├── src/console/admin-pages.tsx
 * ├── src/console/flash.ts
 * ├── src/console/route-types.ts
 * ├── src/console/routes.ts
 * ├── src/console/ui/security-headers.ts
 * ├── src/console/user-pages.tsx
 * ├── src/setup/steps/common.ts
 * └── src/update/update-checker.ts
 * External: none
 *
 * Used by:
 * src/console/admin-routes.ts
 * ├── src/phase07.ts
 * └── test/console.test.ts
 * <module-headers:end>
 */
import { exportAuditJsonl, queryAudit, type AuditFilter } from "../admin/audit-query.ts";
import { replaceToken } from "../admin/api-token.ts";
import { retryDisableWorkersDev, runHealthChecks } from "../admin/health.ts";
import { saveSettings } from "../admin/settings-apply.ts";
import { parseSettingsForm, readSettings } from "../admin/settings-schema.ts";
import { readKey } from "../admin/settings-store.ts";
import { getUser, listUsers, patchUser } from "../admin/users.ts";
import { loadRecord } from "../setup/steps/common.ts";
import { checkForUpdate, readUpdateStatus } from "../update/update-checker.ts";
import { AdminDevicesPage, AdminMachinesPage, DisableUserConfirm, MachineConfirm, UsersPage, type AdminBase } from "./admin-pages.tsx";
import { AuditPage, HealthPage, SettingsPage, UpdatesPage } from "./admin-pages-2.tsx";
import { readFlash, type Flash } from "./flash.ts";
import type { RouteCtx, RouteRow } from "./route-types.ts";
import { done, orgName, originRefusal, page, staleIds } from "./routes.ts";
import { RemovePhoneConfirmPage } from "./user-pages.tsx";
import { redirect, securityHeaders } from "./ui/security-headers.ts";

const admin = { kind: "admin" } as const;
const html = "html" as const;
const enc = encodeURIComponent;

async function base(ctx: RouteCtx): Promise<AdminBase> {
  return { orgName: await orgName(ctx), flash: readFlash(ctx.request), update: await readUpdateStatus(ctx.deps) };
}

const sp = (ctx: RouteCtx, k: string) => ctx.url.searchParams.get(k) || null;

function get(path: string, handler: (ctx: RouteCtx) => Promise<Response>): RouteRow {
  return { method: "GET", path, auth: admin, kind: html, handler };
}

/** A POST that first refuses a foreign Origin. */
function post(path: string, handler: (ctx: RouteCtx, form: FormData) => Promise<Response>): RouteRow {
  return { method: "POST", path, auth: admin, kind: html, handler: async (ctx) => originRefusal(ctx) ?? handler(ctx, await ctx.request.formData()) };
}

async function patchFlash(ctx: RouteCtx, patch: Parameters<typeof patchUser>[3], ok: Flash["kind"]): Promise<Response> {
  const out = await patchUser(ctx.deps, ctx.identity!, ctx.params.id!, patch);
  const user = await getUser(ctx.deps, ctx.params.id!);
  if (!out.ok) return done("/admin/users", { kind: out.code === "last_admin" ? "last_admin" : "user_gone", target: user?.email ?? ctx.params.id! });
  return done("/admin/users", { kind: ok, target: out.user.email, ...(ok === "role_changed" ? { extra: [`They are now ${out.user.role === "admin" ? "an admin" : "a user"}.`] } : {}) });
}

function auditFilter(ctx: RouteCtx): AuditFilter {
  return { actor: sp(ctx, "actor"), action: sp(ctx, "action"), target: sp(ctx, "target"), since: sp(ctx, "since"), until: sp(ctx, "until") };
}

export const ADMIN_ROUTES: readonly RouteRow[] = [
  get("/admin", async () => redirect("/admin/users")),
  get("/admin/users", async (ctx) => {
    const p = await listUsers(ctx.deps, { limit: 50, cursor: sp(ctx, "cursor") });
    return page(ctx, UsersPage({ ...(await base(ctx)), users: p.items, nextCursor: p.next_cursor }));
  }),
  post("/admin/users/:id/role", (ctx, form) => patchFlash(ctx, { role: form.get("role") === "admin" ? "admin" : "user" }, "role_changed")),
  post("/admin/users/:id/enable", (ctx) => patchFlash(ctx, { disabled: false }, "user_enabled")),
  get("/admin/users/:id/disable", async (ctx) => page(ctx, DisableUserConfirm({ ...(await base(ctx)), user: await getUser(ctx.deps, ctx.params.id!), id: ctx.params.id! }))),
  post("/admin/users/:id/disable", (ctx, form) => patchFlash(ctx, { disabled: true, revoke_all: form.get("revoke_all") !== null }, "user_disabled")),

  get("/admin/machines", async (ctx) => {
    const p = await ctx.deps.pairing.listMachines({ cursor: sp(ctx, "cursor"), limit: 50 });
    return page(ctx, AdminMachinesPage({ ...(await base(ctx)), machines: p.items, staleIds: await staleIds(ctx, p.items), nextCursor: p.next_cursor }));
  }),
  ...(["revoke", "rotate"] as const).flatMap((verb) => [
    get(`/admin/machines/:id/${verb}`, async (ctx) => page(ctx, MachineConfirm({ ...(await base(ctx)), machine: await ctx.deps.pairing.getMachine(ctx.params.id!), id: ctx.params.id!, verb }))),
    post(`/admin/machines/:id/${verb}`, async (ctx, form) => {
      const m = await ctx.deps.pairing.getMachine(ctx.params.id!);
      if (!m) return redirect(`/admin/machines/${enc(ctx.params.id!)}/${verb}`);
      const who = { kind: "admin" as const, id: ctx.identity!.user_id };
      if (verb === "revoke") {
        await ctx.deps.provisioning.startTeardown(m.id, "admin_revoke");
        await ctx.deps.audit({ actor: who, action: "machine.revoked", target: { kind: "machine", id: m.id }, outcome: "ok" });
        return done("/admin/machines", { kind: "machine_revoked", target: m.name });
      }
      const evict = form.get("kill_connections") !== null;
      await ctx.deps.provisioning.rotateTunnelSecret(m.id, { evict });
      await ctx.deps.audit({ actor: who, action: "machine.rotated", target: { kind: "machine", id: m.id }, outcome: "ok", detail: { kill_connections: evict } });
      return done("/admin/machines", { kind: "machine_rotated", target: m.name });
    }),
  ]),

  get("/admin/devices", async (ctx) => {
    const p = await ctx.deps.pairing.listDevices({ cursor: sp(ctx, "cursor"), limit: 50 });
    return page(ctx, AdminDevicesPage({ ...(await base(ctx)), devices: p.items, nextCursor: p.next_cursor }));
  }),
  get("/admin/devices/:id/remove", async (ctx) => {
    const action = `/admin/devices/${enc(ctx.params.id!)}/remove`;
    return page(ctx, RemovePhoneConfirmPage({ orgName: await orgName(ctx), device: await ctx.deps.pairing.getDevice(ctx.params.id!), id: ctx.params.id!, action, backHref: "/admin/devices", withSignOut: false }));
  }),
  post("/admin/devices/:id/remove", async (ctx) => {
    const d = await ctx.deps.pairing.getDevice(ctx.params.id!);
    if (!d) return redirect(`/admin/devices/${enc(ctx.params.id!)}/remove`);
    await ctx.deps.pairing.revokeDevice(d.id, { signOutEverywhere: false });
    return done("/admin/devices", { kind: "device_removed", target: d.label });
  }),

  get("/admin/audit", async (ctx) => {
    const f = auditFilter(ctx);
    const p = await queryAudit(ctx.deps.db, f, 50, sp(ctx, "cursor"));
    return page(ctx, AuditPage({ ...(await base(ctx)), filter: f, items: p.items, nextCursor: p.next_cursor }));
  }),
  get("/admin/audit/export", async (ctx) => {
    const body = await exportAuditJsonl(ctx.deps.db, auditFilter(ctx));
    return new Response(body, {
      headers: { ...securityHeaders(), "Content-Type": "application/x-ndjson; charset=utf-8", "Content-Disposition": 'attachment; filename="yaran-audit.jsonl"' },
    });
  }),

  get("/admin/settings", async (ctx) => {
    const zone = (await readKey<string>(ctx.deps.db, "zone_name")) ?? "";
    return page(ctx, SettingsPage({ ...(await base(ctx)), settings: await readSettings(ctx.deps.db), zoneName: zone }));
  }),
  post("/admin/settings", async (ctx, form) => {
    const value = parseSettingsForm(form);
    const out = await saveSettings(ctx.deps, ctx.identity!, value);
    if (!out.ok) {
      const zone = (await readKey<string>(ctx.deps.db, "zone_name")) ?? "";
      return page(ctx, SettingsPage({ ...(await base(ctx)), settings: value, zoneName: zone, errors: out.errors }), 400);
    }
    const failed = out.effects.filter((e) => !e.ok).map((e) => `Applying ${e.what} to Cloudflare failed; save again to retry.`);
    const applied = out.effects.filter((e) => e.ok).map((e) => `Applied ${e.what} to Cloudflare.`);
    return done("/admin/settings", { kind: "settings_saved", extra: [out.changed.length ? `Changed: ${out.changed.join(", ")}.` : "Nothing changed.", ...applied, ...failed] });
  }),

  get("/admin/health", async (ctx) => page(ctx, HealthPage({ ...(await base(ctx)), checks: await runHealthChecks(ctx.deps) }))),
  post("/admin/health/disable-workers-dev", async (ctx) => {
    const ok = await retryDisableWorkersDev(ctx.deps, ctx.identity!.user_id);
    return done("/admin/health", { kind: ok ? "workers_dev_disabled" : "workers_dev_failed" });
  }),
  post("/admin/health/replace-token", async (ctx, form) => {
    const r = await loadRecord(ctx.deps.db);
    const out = await replaceToken(ctx.deps, String(form.get("token") ?? "").trim(), r.account_id!, r.script_name!, ctx.identity!.user_id);
    if (!out.stored) return page(ctx, HealthPage({ ...(await base(ctx)), checks: await runHealthChecks(ctx.deps), probe: out.rows }), 400);
    return done("/admin/health", { kind: "token_replaced" });
  }),

  get("/admin/updates", async (ctx) => page(ctx, UpdatesPage({ ...(await base(ctx)), status: await readUpdateStatus(ctx.deps), settings: await readSettings(ctx.deps.db) }))),
  post("/admin/updates/check", async (ctx) => {
    const s = await checkForUpdate(ctx.deps);
    return done("/admin/updates", { kind: "update_checked", extra: [s.error ? `It failed: ${s.error}.` : s.update_available ? `Version ${s.latest} is available.` : "You are on the latest release."] });
  }),
];
