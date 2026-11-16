/**
 * The relay's runtime-agnostic request handler (`Request → Response`, Web Crypto only), used
 * unchanged by the Worker entry and by the Node fallback runtime.
 *
 * Routes: R1 GET /v1/meta (RelayMeta), R2 POST /v1/endpoints (mint, JSON, Yaran-Protocol
 * negotiated, rate-limited per client IP), R3 POST /w/<endpoint> (receive). Anything else is
 * 404, a known path with the wrong method 405. Every answer carries Yaran-Protocol and
 * Yaran-Request-Id; an unexpected error is 500 internal with no detail.
 *
 * <module-headers:begin>
 * Uses:
 * src/core/handler.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/core/deps.ts
 * ├── src/core/http.ts
 * ├── src/core/mint.ts
 * └── src/core/receive.ts
 * External: none
 *
 * Used by:
 * src/core/handler.ts
 * ├── src/runtime/node.ts
 * ├── src/runtime/worker.ts
 * └── test/helpers/runtimes.ts
 * <module-headers:end>
 */
import { PROTOCOL_MAX, PROTOCOL_MIN, type RelayMeta } from "@yaran/protocol";
import type { RelayDeps } from "./deps.ts";
import { fail, json, readCapped } from "./http.ts";
import { mint, servedApps } from "./mint.ts";
import { receive } from "./receive.ts";

const MINT_MAX_BODY = 8192;

export type RelayHandler = (req: Request, clientIp: string | null) => Promise<Response>;

export function relayMeta(deps: RelayDeps): RelayMeta {
  return {
    service: "yaran-push-relay",
    protocol: { min: PROTOCOL_MIN, max: PROTOCOL_MAX },
    apps: servedApps(deps),
    channels: deps.fcm ? ["apns", "fcm"] : ["apns"],
    endpoint_key_id: deps.keys.current,
  };
}

export function createRelay(deps: RelayDeps): RelayHandler {
  return async (req, clientIp) => {
    const requestId = crypto.randomUUID();
    try {
      return await route(deps, req, clientIp, requestId);
    } catch (err) {
      deps.log("error", "relay.internal", { reason: err instanceof Error ? err.name : "unknown" });
      return fail("internal", "The relay failed unexpectedly.", requestId);
    }
  };
}

async function route(deps: RelayDeps, req: Request, clientIp: string | null, requestId: string): Promise<Response> {
  const path = new URL(req.url).pathname;
  if (path === "/v1/meta") {
    return req.method === "GET" ? json(200, relayMeta(deps), requestId) : fail("method_not_allowed", "Use GET for /v1/meta.", requestId);
  }
  if (path === "/v1/endpoints") {
    if (req.method !== "POST") return fail("method_not_allowed", "Use POST for /v1/endpoints.", requestId);
    const version = Number(req.headers.get("Yaran-Protocol"));
    if (!Number.isInteger(version) || version < PROTOCOL_MIN || version > PROTOCOL_MAX) {
      return fail("protocol_unsupported", "Send a Yaran-Protocol header this relay supports.", requestId, { min: PROTOCOL_MIN, max: PROTOCOL_MAX });
    }
    if (!(await deps.limiters.mint.allow(clientIp ?? "unknown"))) return fail("rate_limited", "Too many endpoint requests; retry after a minute.", requestId);
    if (!(req.headers.get("Content-Type") ?? "").toLowerCase().startsWith("application/json")) {
      return fail("unsupported_media_type", "Send the mint request as application/json.", requestId);
    }
    const raw = await readCapped(req, MINT_MAX_BODY);
    if (raw === "too_large") return fail("payload_too_large", `A mint request may be at most ${MINT_MAX_BODY} bytes.`, requestId);
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return fail("bad_request", "The body is not JSON.", requestId);
    }
    return mint(deps, body, requestId);
  }
  if (path.startsWith("/w/")) {
    if (req.method !== "POST") return fail("method_not_allowed", "Use POST to deliver a push.", requestId);
    return receive(deps, path.slice(3), req, requestId);
  }
  return fail("not_found", "No such relay route.", requestId);
}
