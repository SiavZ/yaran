/**
 * Builds Phase 07's `RouteCtx` from 04's `RequestContext` and turns 07's rows into 04 routes.
 *
 * Every dependency is the real one: 04's D1, data key, audit writer and Access verifier,
 * 05's Cloudflare client and provisioning facade, and 06's machine and phone services.
 *
 * - Route rules: a JSON row (the admin API) negotiates `Yaran-Protocol`; an HTML row
 *   (setup wizard, consoles) does not. Setup rows count against the `auth` bucket, the rest
 *   against `ip`.
 * - 07's handlers read the body from `request`, so the row gets a request rebuilt over the
 *   bytes 04's pipeline already read and capped.
 *
 * <module-headers:begin>
 * Uses:
 * src/routes/phase07-context.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/admin/pairing-service.ts
 * ├── src/admin/ports.ts
 * ├── src/audit/audit.ts
 * ├── src/auth/access-jwt.ts
 * ├── src/cloudflare/budget.ts
 * ├── src/cloudflare/client.ts
 * ├── src/console/route-types.ts
 * ├── src/db/settings.ts
 * ├── src/http/context.ts
 * ├── src/http/routes.ts
 * ├── src/provisioning/context.ts
 * ├── src/provisioning/index.ts
 * ├── src/routes/phase06-context.ts
 * ├── src/security/data-key.ts
 * ├── src/security/secrets.ts
 * └── src/update/worker-version.ts
 * External: none
 *
 * Used by:
 * src/routes/phase07-context.ts
 * ├── src/admin/scheduled-jobs.ts
 * ├── src/phase07.ts
 * └── test/helpers/deps.ts
 * <module-headers:end>
 */
import { utf8Decode } from "@yaran/protocol";
import type { AuditInput, Identity } from "../admin/ports.ts";
import { pairingService } from "../admin/pairing-service.ts";
import { record } from "../audit/audit.ts";
import { verifyAccessJwt } from "../auth/access-jwt.ts";
import { ApiBudget } from "../cloudflare/budget.ts";
import { CfClient, resolveCfBaseUrl } from "../cloudflare/client.ts";
import type { Phase07Deps, RouteCtx, RouteRow } from "../console/route-types.ts";
import { getSettings } from "../db/settings.ts";
import type { Actor, AppContext, RequestContext } from "../http/context.ts";
import type { Route } from "../http/routes.ts";
import { CF_USER_AGENT, provCtx } from "../provisioning/context.ts";
import { deriveUserSlug, requestReconcile, rotateTunnelSecret, startTeardown } from "../provisioning/index.ts";
import { decodeDataKey } from "../security/secrets.ts";
import { open, seal } from "../security/data-key.ts";
import { WORKER_VERSION } from "../update/worker-version.ts";
import { asHttpError, phase06Ctx } from "./phase06-context.ts";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function toActor(a: AuditInput["actor"]): Actor {
  switch (a.kind) {
    case "system":
      return { kind: "system" };
    case "setup":
      return { kind: "setup" };
    case "user":
    case "admin":
      // The audit writer records kind and id only; the email is never written.
      return { kind: a.kind, id: a.id ?? "", email: "" };
  }
}

async function accessIdentity(ctx: AppContext, request: Request): Promise<{ email: string; sub: string } | null> {
  const s = await getSettings(ctx.db, ["team_domain", "control_plane_aud", "jwt_clock_tolerance_s"]);
  try {
    const claims = await verifyAccessJwt(request, { teamDomain: s.team_domain, aud: s.control_plane_aud, clockToleranceS: s.jwt_clock_tolerance_s ?? 60, now: ctx.now() });
    return { email: claims.email, sub: claims.sub };
  } catch {
    return null;
  }
}

/** Phase 07's dependencies for a request or a cron run. */
export function phase07Deps(ctx: AppContext, identity: Identity | null = null): Phase07Deps {
  const now = () => ctx.now();
  const prov = () => provCtx(ctx);
  const actor = identity ? { kind: identity.role, id: identity.user_id } : { kind: "system" as const, id: null };
  return {
    db: ctx.db,
    env: ctx.env,
    sealer: {
      seal: (purpose, aad, plaintext) => seal(ctx, purpose, aad, plaintext),
      open: async (purpose, aad, sealed) => utf8Decode(await open(ctx, purpose, aad, sealed)) ?? "",
    },
    dataKeyValid: (key) => decodeDataKey(key) !== null,
    audit: (e) =>
      record({ ...ctx, actor: () => toActor(e.actor) }, {
        action: e.action,
        target: { kind: e.target.kind, ...(e.target.id ? { id: e.target.id } : {}) },
        outcome: e.outcome,
        ...(e.detail ? { detail: e.detail } : {}),
      }),
    accessIdentity: (request) => accessIdentity(ctx, request),
    cfFor: (token) => {
      const client = new CfClient({ fetch: (i, init) => fetch(i, init), token, baseUrl: resolveCfBaseUrl(ctx.env.CF_API_BASE_URL), budget: new ApiBudget(ctx.db, now), userAgent: CF_USER_AGENT, sleep });
      return {
        async request<T>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
          try {
            return (await client.request<T>(method, path, { priority: "interactive", ...(body === undefined ? {} : { body }) })).result;
          } finally {
            await client.budget.flush();
          }
        },
      };
    },
    provisioning: {
      startTeardown: async (id, reason) => void (await startTeardown(prov(), id, reason)),
      rotateTunnelSecret: async (id, o) => void (await rotateTunnelSecret(prov(), id, o)),
      // The drift task re-applies the desired Access app (session duration included) to
      // every machine; a reconcile request resets its cursor and runs it on the next tick.
      reapplySessionDuration: async () => requestReconcile(prov()),
      deriveUserSlug,
    },
    pairing: pairingService(phase06Ctx(ctx), actor),
    fetch: (i, init) => fetch(i, init),
    now: () => new Date(ctx.now() * 1000),
    newId: () => crypto.randomUUID(),
    workerVersion: WORKER_VERSION,
  };
}

function identityOf(ctx: RequestContext): Identity | null {
  return ctx.identity.kind === "user" ? { user_id: ctx.identity.user.id, email: ctx.identity.user.email, role: ctx.identity.user.role } : null;
}

/** One 07 row as a 04 route. */
export function toRoute07(row: RouteRow): Route {
  return {
    method: row.method,
    path: row.path,
    auth: row.auth,
    kind: row.kind,
    protocol: row.kind === "json" ? "header" : "none",
    rateLimit: row.auth.kind === "setup" ? "auth" : "ip",
    handler: async (ctx) => {
      const hasBody = ctx.request.method !== "GET" && ctx.request.method !== "HEAD";
      const request = new Request(ctx.request.url, { method: ctx.request.method, headers: ctx.request.headers, ...(hasBody ? { body: ctx.body } : {}) });
      const identity = identityOf(ctx);
      const call: RouteCtx = { request, url: ctx.url, params: ctx.params, identity, deps: phase07Deps(ctx, identity), requestId: ctx.requestId };
      try {
        return await row.handler(call);
      } catch (e) {
        throw asHttpError(e);
      }
    },
  };
}
