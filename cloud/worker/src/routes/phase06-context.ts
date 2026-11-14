/**
 * Builds Phase 06's `RouteCall` from 04's `RequestContext` and turns 06's rows into 04 routes.
 *
 * Every service is the real one: 04's audit writer, D1 strict counters, data key and
 * settings, and 05's provisioning facade and Cloudflare client bound to the request.
 * Provisioning and Cloudflare refusals become `HttpError`s with their registry code, so
 * the pipeline renders them like any other refusal.
 *
 * - A `user` or `admin` route first runs the install-id check (W12: a revoked phone gets
 *   `device_revoked`, a live one has its `last_seen_at` refreshed).
 *
 * <module-headers:begin>
 * Uses:
 * src/routes/phase06-context.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/audit/audit.ts
 * ├── src/cloudflare/errors.ts
 * ├── src/db/settings.ts
 * ├── src/devices/install-id.ts
 * ├── src/http/context.ts
 * ├── src/http/responses.ts
 * ├── src/http/routes.ts
 * ├── src/provisioning/context.ts
 * ├── src/provisioning/index.ts
 * ├── src/provisioning/ports.ts
 * ├── src/provisioning/provision-error.ts
 * ├── src/routes/call.ts
 * ├── src/security/data-key.ts
 * ├── src/security/rate-limit.ts
 * └── src/security/sanitize.ts
 * External: none
 *
 * Used by:
 * src/routes/phase06-context.ts
 * ├── src/pairing/sweep.ts
 * ├── src/routes/pairing-and-sessions.ts
 * └── test/phase06/fakes.ts
 * <module-headers:end>
 */
import { utf8Decode, type ErrorCode, type Settings } from "@yaran/protocol";
import { record } from "../audit/audit.ts";
import { CfApiError, safeErrorDetail, wireCodeFor } from "../cloudflare/errors.ts";
import { getSettings, readContractSettings } from "../db/settings.ts";
import { checkInstallId } from "../devices/install-id.ts";
import type { Actor, AppContext, RequestContext } from "../http/context.ts";
import { HttpError } from "../http/responses.ts";
import type { Route } from "../http/routes.ts";
import { provCtx } from "../provisioning/context.ts";
import { driveOp, fetchTunnelToken, rotateTunnelSecret, setOriginPort, startProvision, startTeardown } from "../provisioning/index.ts";
import type { ProvCtx } from "../provisioning/ports.ts";
import { ProvisionError } from "../provisioning/provision-error.ts";
import { macKey, open, seal } from "../security/data-key.ts";
import { strictHit } from "../security/rate-limit.ts";
import { forTerminal } from "../security/sanitize.ts";
import type { AuditRecord, FoundationCtx, MachineIdentity, OrgSettings, Phase06Ctx, ProvisioningFacade, RouteCall, RouteRow, UserIdentity } from "./call.ts";

/** Phase 06's tier-2 buckets: per-user pairing attempts and handoffs per JWT sub. */
export const PHASE06_RATE_BUCKETS = {
  pair: { limit: 10, windowS: 600 },
  handoff: { limit: 20, windowS: 60 },
} as const;

function toActor(a: AuditRecord["actor"]): Actor {
  switch (a.kind) {
    case "system":
      return { kind: "system" };
    case "machine":
      return { kind: "machine", id: a.id };
    case "user":
    case "admin":
      // The audit writer records kind and id only; the email is never written.
      return { kind: a.kind, id: a.id ?? "", email: "" };
  }
}

/** A provisioning or Cloudflare refusal as the `HttpError` the pipeline renders. */
export function asHttpError(e: unknown): unknown {
  if (e instanceof ProvisionError) return new HttpError(e.code, e.message, Object.keys(e.details).length ? { details: e.details } : {});
  if (e instanceof CfApiError) {
    const headers: Record<string, string> = e.retryAfter === null ? {} : { "Retry-After": String(e.retryAfter) };
    return new HttpError(wireCodeFor(e.kind), forTerminal(e.message), { details: safeErrorDetail(e, forTerminal), headers });
  }
  return e;
}

async function viaHttp<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    throw asHttpError(e);
  }
}

export function foundationCtx(ctx: AppContext): FoundationCtx {
  return {
    db: ctx.db,
    now: () => ctx.now(),
    requestId: ctx.requestId,
    audit: {
      record: (r) =>
        record({ ...ctx, actor: () => toActor(r.actor) }, {
          action: r.action,
          target: { kind: r.target.kind, ...(r.target.id ? { id: r.target.id } : {}) },
          outcome: r.outcome,
          ...(r.errorCode ? { errorCode: r.errorCode } : {}),
          ...(r.detail ? { detail: r.detail } : {}),
        }),
    },
    rateLimit: async (bucket, key) => {
      const b = PHASE06_RATE_BUCKETS[bucket];
      const r = await strictHit(ctx.db, `p06:${bucket}:${key}`, b.limit, b.windowS, ctx.now());
      return r.ok ? { ok: true } : { ok: false, retryAfterS: Math.max(1, r.retryAfter) };
    },
    dataKey: {
      seal: (purpose, aad, plaintext) => seal(ctx, purpose, aad, plaintext),
      open: async (purpose, aad, sealed) => utf8Decode(await open(ctx, purpose, aad, sealed)) ?? "",
      macKey: (purpose) => macKey(ctx, purpose),
    },
  };
}

export async function orgSettings(db: D1Database): Promise<OrgSettings> {
  const s = await getSettings(db, ["setup_state", "control_plane_host", "team_domain", "zone_name", "account_id", "vapid_public_key"]);
  return {
    setupState: s.setup_state ?? "open",
    controlPlaneHost: s.control_plane_host,
    teamDomain: s.team_domain,
    zoneName: s.zone_name,
    accountId: s.account_id,
    vapidPublicKey: s.vapid_public_key,
  };
}

function provisioningFacade(p: () => ProvCtx): ProvisioningFacade {
  return {
    startProvision: (id) => viaHttp(async () => ({ opId: (await startProvision(p(), id)).op_id })),
    driveOp: (opId, budget) =>
      viaHttp(async () => {
        const v = await driveOp(p(), opId, budget);
        return { state: v.state, errorCode: v.error_code as ErrorCode | null, ...(v.error_detail ? { details: v.error_detail } : {}) };
      }),
    startTeardown: (id, reason) => viaHttp(async () => ({ opId: (await startTeardown(p(), id, reason)).op_id })),
    rotateTunnelSecret: (id, o) => viaHttp(() => rotateTunnelSecret(p(), id, o)),
    fetchTunnelToken: (id) => viaHttp(() => fetchTunnelToken(p(), id)),
    setOriginPort: (id, port) => viaHttp(async () => ({ changed: (await setOriginPort(p(), id, port)).changed })),
  };
}

/** Phase 06's context for a request or a cron run. */
export function phase06Ctx(ctx: AppContext): Phase06Ctx {
  let prov: ProvCtx | undefined;
  const p = () => (prov ??= provCtx(ctx));
  return {
    ...foundationCtx(ctx),
    env: ctx.env,
    provisioning: provisioningFacade(p),
    cloudflare: {
      call: (req) =>
        viaHttp(async () => {
          try {
            return (await p().cf.request<never>(req.method, req.path, { priority: "interactive", ...(req.body === undefined ? {} : { body: req.body }) })).result;
          } finally {
            await p().cf.budget.flush();
          }
        }),
    },
    settings: { read: (): Promise<Settings> => readContractSettings(ctx.db), internal: () => orgSettings(ctx.db) },
  };
}

function identities(ctx: RequestContext): { user: UserIdentity | null; machine: MachineIdentity | null } {
  const id = ctx.identity;
  switch (id.kind) {
    case "user":
      return {
        user: { userId: id.user.id, email: id.user.email, sub: id.claims.sub, exp: id.claims.exp, role: id.user.role, slug: id.user.slug },
        machine: null,
      };
    case "machine":
      return { user: null, machine: { id: id.machineId, protocol: id.protocol } };
    case "anonymous":
    case "setup":
      return { user: null, machine: null };
  }
}

/** One 06 row as a 04 route. */
export function toRoute(row: RouteRow): Route {
  return {
    method: row.method,
    path: row.path,
    auth: row.auth,
    kind: row.kind,
    protocol: row.protocol,
    rateLimit: row.rateLimit,
    bodyLimit: row.bodyLimit,
    handler: async (ctx) => {
      const call: RouteCall = { req: ctx.request, ctx: phase06Ctx(ctx), params: ctx.params, body: ctx.body, ...identities(ctx) };
      if (call.user) await checkInstallId(call.ctx, call.user, ctx.request.headers.get("Yaran-Install-Id"));
      return viaHttp(() => row.handler(call));
    },
  };
}
