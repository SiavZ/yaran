/**
 * The ordered request pipeline every request runs through. The order is the security
 * argument, so it lives in one function:
 *
 * 1. Host guard (setup state and `control_plane_host`).
 * 2. Canonical-path check, then route match (404 / 405 without touching auth).
 * 3. Setup-state gating by auth class, then the secrets gate (`503 unavailable` for every
 *    route but `public` when a Deploy-time secret is missing or malformed).
 * 4. Rate limit.
 * 5. Protocol negotiation (`Yaran-Protocol` header, or `v` on HTML navigations).
 * 6. Body size and content type, and the CSRF rule for console mutations and form posts.
 * 7. Auth class (`auth/authorize.ts`).
 * 8. Handler.
 *
 * Every response, errors included, leaves through `finalize`, which stamps the protocol,
 * request-id and security headers. An unexpected exception is `500 internal`; its text
 * goes only to the log, sanitized.
 *
 * <module-headers:begin>
 * Uses:
 * src/http/pipeline.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/auth/authorize.ts
 * ├── src/auth/machine-signature.ts
 * ├── src/db/settings.ts
 * ├── src/env.ts
 * ├── src/http/body.ts
 * ├── src/http/context.ts
 * ├── src/http/host-guard.ts
 * ├── src/http/responses.ts
 * ├── src/http/router.ts
 * ├── src/http/routes.ts
 * ├── src/log/logger.ts
 * ├── src/security/rate-limit.ts
 * └── src/security/secrets.ts
 * External: none
 *
 * Used by:
 * src/http/pipeline.ts
 * ├── src/index.ts
 * └── test/helpers/worker.ts
 * <module-headers:end>
 */
import { PROTOCOL_HEADER_RE, PROTOCOL_MAX, PROTOCOL_MIN, SIG_HEADERS, UUID_RE } from "@yaran/protocol";
import { authorize } from "../auth/authorize.ts";
import { noPairCodes, type PairCodeKeyResolver } from "../auth/machine-signature.ts";
import { getSettings } from "../db/settings.ts";
import type { Env } from "../env.ts";
import { createLogger } from "../log/logger.ts";
import { enforceRouteLimit } from "../security/rate-limit.ts";
import { secretsUsable } from "../security/secrets.ts";
import { isJsonContentType, readBody } from "./body.ts";
import { actorOf, type RequestContext } from "./context.ts";
import { checkHost, gateRoute } from "./host-guard.ts";
import { errorResponse, finalize, HttpError, type ResponseKind } from "./responses.ts";
import { compileRoutes, isCanonicalPath } from "./router.ts";
import { DEFAULT_BODY_LIMIT, type Route } from "./routes.ts";

export interface PipelineDeps {
  /** W4's key resolver (Phase 06 supplies it). */
  pairCodeKey: PairCodeKeyResolver;
  /** Unix seconds; injectable for tests. */
  now: () => number;
}

const REQUEST_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function requestIdOf(request: Request): string {
  const ray = request.headers.get("CF-Ray");
  if (ray && REQUEST_ID_RE.test(ray)) return ray;
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
}

function negotiate(raw: string | null): number | null {
  if (raw === null || !PROTOCOL_HEADER_RE.test(raw)) return null;
  const n = Number(raw);
  return n >= PROTOCOL_MIN && n <= PROTOCOL_MAX ? n : null;
}

export type FetchHandler = (request: Request, env: Env, exec: ExecutionContext) => Promise<Response>;

/** Builds the fetch handler for a route table. */
export function createFetchHandler(routes: readonly Route[], overrides: Partial<PipelineDeps> = {}): FetchHandler {
  const router = compileRoutes(routes);
  const deps: PipelineDeps = { pairCodeKey: noPairCodes, now: () => Math.floor(Date.now() / 1000), ...overrides };

  return async (request, env, exec) => {
    const url = new URL(request.url);
    const requestId = requestIdOf(request);
    const cf = request.cf as { country?: unknown } | undefined;
    const ctx: RequestContext = {
      env, db: env.DB, request, url, requestId,
      log: createLogger({ request_id: requestId }),
      now: deps.now,
      ip: request.headers.get("CF-Connecting-IP"),
      country: typeof cf?.country === "string" ? cf.country : null,
      actor: () => actorOf(ctx.identity),
      waitUntil: (p) => exec.waitUntil(p),
      route: null, params: {}, body: new Uint8Array(0), identity: { kind: "anonymous" }, protocol: null,
    };
    let kind: ResponseKind = "json";
    let cacheControl: string | undefined;
    let response: Response;
    try {
      response = await run();
    } catch (err) {
      if (!(err instanceof HttpError)) ctx.log.error("unhandled_exception", { route: ctx.route, error: err });
      response = errorResponse(err instanceof HttpError ? err : new HttpError("internal"), kind, requestId);
    }
    const out = finalize(response, { requestId, protocol: ctx.protocol ?? PROTOCOL_MAX, ...(cacheControl ? { cacheControl } : {}) });
    const actor = ctx.actor();
    ctx.log[out.status >= 500 ? "error" : "info"]("request", {
      method: request.method, route: ctx.route, status: out.status,
      actor_kind: actor.kind, actor_id: "id" in actor ? actor.id : null,
    });
    return out;

    async function run(): Promise<Response> {
      const settings = await getSettings(ctx.db, ["setup_state", "control_plane_host", "team_domain", "control_plane_aud", "jwt_clock_tolerance_s"]);
      const host = { setup: settings.setup_state ?? "open", controlPlaneHost: settings.control_plane_host };
      checkHost(host, url.hostname);

      const path = url.pathname;
      if (!isCanonicalPath(path)) throw new HttpError("not_found");
      const match = router.match(request.method, path);
      if (match.kind === "not_found") throw new HttpError("not_found");
      if (match.kind === "method_not_allowed") throw new HttpError("method_not_allowed", undefined, { headers: { Allow: match.allow.join(", ") } });
      const { route } = match;
      kind = route.kind;
      ctx.route = route.path;
      ctx.params = match.params;
      if (route.auth.kind === "public") cacheControl = "public, max-age=60";

      gateRoute(host, route.auth);
      if (route.auth.kind !== "public" && !secretsUsable(env, ctx.log)) {
        throw new HttpError("unavailable", "The Worker is missing a required secret; an administrator must check its logs.");
      }

      const machineHeader = request.headers.get(SIG_HEADERS.machineId);
      await enforceRouteLimit(ctx, route.rateLimit, machineHeader && UUID_RE.test(machineHeader) ? machineHeader : null);

      if (route.protocol !== "none") {
        const raw = route.protocol === "header" ? request.headers.get(SIG_HEADERS.protocol) : url.searchParams.get("v");
        ctx.protocol = negotiate(raw);
        if (ctx.protocol === null) {
          throw new HttpError("protocol_unsupported", `This server speaks protocol ${PROTOCOL_MIN} to ${PROTOCOL_MAX}.`, { details: { min: PROTOCOL_MIN, max: PROTOCOL_MAX } });
        }
      }

      ctx.body = MUTATING.has(request.method) ? await readBody(request, route.bodyLimit ?? DEFAULT_BODY_LIMIT) : new Uint8Array(0);
      const consoleApi = path === "/v1/me" || path.startsWith("/v1/me/") || path.startsWith("/v1/admin/");
      if (route.kind === "json" && (ctx.body.length > 0 || (consoleApi && MUTATING.has(request.method) && request.method !== "DELETE"))) {
        if (!isJsonContentType(request)) throw new HttpError("unsupported_media_type", "Send the request body as application/json.");
      }
      if (MUTATING.has(request.method) && (consoleApi || route.kind === "html")) {
        const origin = request.headers.get("Origin");
        if (origin !== null && origin !== `https://${settings.control_plane_host ?? url.host}`) {
          throw new HttpError("origin_mismatch", "This request came from another site and was refused.");
        }
      }

      ctx.identity = await authorize(ctx, route.auth, {
        setupClosed: host.setup === "closed",
        access: { teamDomain: settings.team_domain, aud: settings.control_plane_aud, clockToleranceS: settings.jwt_clock_tolerance_s ?? 60, now: ctx.now() },
        pairCodeKey: deps.pairCodeKey,
      });
      return route.handler(ctx);
    }
  };
}
