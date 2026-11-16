/**
 * The single place a request gets an identity: one exhaustive switch over the route's
 * auth class (see `http/routes.ts`), ending in `assertNever`.
 *
 * - `public`, `setup`: no identity here (07's setup gate checks the setup code itself).
 * - `machine`: the Ed25519 signature (`machine-signature.ts`).
 * - `user`: a valid Access JWT for the control-plane app and an active user row.
 * - `admin`: as `user`, plus `role = admin` from D1.
 *
 * Denied attempts are audited (`access.denied`, coalesced per actor and minute) only on
 * admin routes and for revoked-machine calls. A request with no JWT at all is logged at
 * warn level: it means Access is not in front of a route it should cover.
 *
 * <module-headers:begin>
 * Uses:
 * src/auth/authorize.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/audit/audit.ts
 * ├── src/auth/access-jwt.ts
 * ├── src/auth/identity.ts
 * ├── src/auth/machine-signature.ts
 * ├── src/http/context.ts
 * ├── src/http/responses.ts
 * └── src/http/routes.ts
 * External: none
 *
 * Used by:
 * src/auth/authorize.ts
 * └── src/http/pipeline.ts
 * <module-headers:end>
 */
import { SIG_HEADERS } from "@yaran/protocol";
import { record } from "../audit/audit.ts";
import type { Identity, RequestContext } from "../http/context.ts";
import { HttpError } from "../http/responses.ts";
import type { RouteAuth } from "../http/routes.ts";
import { ACCESS_JWT_HEADER, verifyAccessJwt, type AccessConfig } from "./access-jwt.ts";
import { resolveUser } from "./identity.ts";
import { verifyMachine, type PairCodeKeyResolver } from "./machine-signature.ts";

export interface AuthConfig {
  setupClosed: boolean;
  access: AccessConfig;
  pairCodeKey: PairCodeKeyResolver;
}

/** Identity failures that are a denial (not an outage) and are audited on admin routes. */
const DENIALS: ReadonlySet<string> = new Set(["unauthenticated", "service_token_rejected", "user_disabled"]);

function assertNever(value: never): never {
  throw new Error(`unhandled auth class ${JSON.stringify(value)}`);
}

async function userIdentity(ctx: RequestContext, cfg: AuthConfig): Promise<Extract<Identity, { kind: "user" }>> {
  try {
    const claims = await verifyAccessJwt(ctx.request, cfg.access);
    return { kind: "user", user: await resolveUser(ctx.db, claims, cfg.setupClosed, ctx.now()), claims };
  } catch (err) {
    if (err instanceof HttpError && err.code === "unauthenticated" && !ctx.request.headers.has(ACCESS_JWT_HEADER)) {
      ctx.log.warn("access_jwt_missing", { route: ctx.route, cf_ray: ctx.request.headers.get("CF-Ray") });
    }
    throw err;
  }
}

async function auditDenied(ctx: RequestContext, actor: ReturnType<RequestContext["actor"]>, code: HttpError["code"], targetKind: "org" | "machine", targetId?: string) {
  const as: RequestContext = { ...ctx, actor: () => actor };
  await record(as, {
    action: "access.denied",
    outcome: "denied",
    errorCode: code,
    target: targetId ? { kind: targetKind, id: targetId } : { kind: targetKind },
    detail: { method: ctx.request.method, route: ctx.route },
  });
}

/** Authenticates the request for `auth`; throws the registry error that refuses it. */
export async function authorize(ctx: RequestContext, auth: RouteAuth, cfg: AuthConfig): Promise<Identity> {
  switch (auth.kind) {
    case "public":
      return { kind: "anonymous" };
    case "setup":
      return { kind: "setup" };
    case "machine":
      try {
        return await verifyMachine(ctx, auth.key, cfg.pairCodeKey);
      } catch (err) {
        if (err instanceof HttpError && err.code === "machine_revoked") {
          const id = ctx.request.headers.get(SIG_HEADERS.machineId);
          await auditDenied(ctx, { kind: "machine", id }, err.code, "machine", id ?? undefined);
        }
        throw err;
      }
    case "user":
      return userIdentity(ctx, cfg);
    case "admin": {
      let identity: Extract<Identity, { kind: "user" }>;
      try {
        identity = await userIdentity(ctx, cfg);
      } catch (err) {
        if (err instanceof HttpError && DENIALS.has(err.code)) await auditDenied(ctx, { kind: "system" }, err.code, "org");
        throw err;
      }
      if (identity.user.role !== "admin") {
        await auditDenied(ctx, { kind: "user", id: identity.user.id, email: identity.user.email }, "forbidden", "org");
        throw new HttpError("forbidden", "This action needs an administrator.");
      }
      return identity;
    }
    default:
      return assertNever(auth);
  }
}
