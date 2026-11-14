/**
 * Pipeline test kit: one probe route per auth class (so the authorization matrix has a
 * row for each even before Phases 05–08 add theirs), and a caller that runs a request
 * through `createFetchHandler` with a fixed clock.
 *
 * <module-headers:begin>
 * Uses:
 * test/helpers/worker.ts
 * ├── src/http/pipeline.ts
 * ├── src/http/responses.ts
 * ├── src/http/routes.ts
 * └── test/helpers/seed.ts
 * External: cloudflare:test
 *
 * Used by:
 * test/helpers/worker.ts
 * ├── test/access-jwt.test.ts
 * ├── test/authz-matrix.test.ts
 * ├── test/body.test.ts
 * ├── test/helpers/matrix.ts
 * ├── test/host-guard.test.ts
 * ├── test/identity.test.ts
 * ├── test/machine-signature.test.ts
 * ├── test/no-secret-leak.test.ts
 * ├── test/pairing/authorize-route.test.ts
 * ├── test/phase06/harness.ts
 * ├── test/rate-limit.test.ts
 * ├── test/responses.test.ts
 * ├── test/router.test.ts
 * ├── test/secrets.test.ts
 * └── test/sessions/handoff-route.test.ts
 * <module-headers:end>
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { createFetchHandler, type PipelineDeps } from "../../src/http/pipeline.ts";
import { json } from "../../src/http/responses.ts";
import { ROUTES, type Route } from "../../src/http/routes.ts";
import { NOW } from "./seed.ts";

const echo: Route["handler"] = async (ctx) => {
  const id = ctx.identity;
  return json({
    identity: id.kind,
    user: id.kind === "user" ? id.user.email : null,
    machine: id.kind === "machine" ? id.machineId : null,
    params: ctx.params,
    body: new TextDecoder().decode(ctx.body),
  });
};

export const PROBE_ROUTES: readonly Route[] = [
  { method: "GET", path: "/v1/meta", auth: { kind: "public" }, kind: "json", protocol: "none", rateLimit: "ip", handler: echo },
  { method: "GET", path: "/setup", auth: { kind: "setup" }, kind: "html", protocol: "none", rateLimit: "auth", handler: echo },
  { method: "POST", path: "/setup/code", auth: { kind: "setup" }, kind: "html", protocol: "none", rateLimit: "auth", handler: echo },
  { method: "POST", path: "/v1/machine/probe", auth: { kind: "machine", key: "registered" }, kind: "json", protocol: "header", rateLimit: "machine", handler: echo },
  { method: "GET", path: "/v1/machine/config", auth: { kind: "machine", key: "registered" }, kind: "json", protocol: "header", rateLimit: "machine", handler: echo },
  { method: "POST", path: "/v1/machine/events", auth: { kind: "machine", key: "registered" }, kind: "json", protocol: "header", rateLimit: "machine", handler: echo },
  { method: "POST", path: "/v1/machine/claim", auth: { kind: "machine", key: "pair_request" }, kind: "json", protocol: "header", rateLimit: "machine", handler: echo },
  { method: "POST", path: "/v1/machine/unpair", auth: { kind: "machine", key: "registered" }, kind: "json", protocol: "header", rateLimit: "machine", handler: echo },
  { method: "PUT", path: "/v1/machine/origin", auth: { kind: "machine", key: "registered" }, kind: "json", protocol: "header", rateLimit: "machine", handler: echo },
  { method: "GET", path: "/v1/me", auth: { kind: "user" }, kind: "json", protocol: "header", rateLimit: "ip", handler: echo },
  { method: "POST", path: "/v1/me/devices", auth: { kind: "user" }, kind: "json", protocol: "header", rateLimit: "ip", handler: echo },
  { method: "DELETE", path: "/v1/me/devices/:id", auth: { kind: "user" }, kind: "json", protocol: "header", rateLimit: "ip", handler: echo },
  { method: "GET", path: "/v1/handoff", auth: { kind: "user" }, kind: "html", protocol: "query", rateLimit: "auth", handler: echo },
  { method: "POST", path: "/v1/handoff", auth: { kind: "user" }, kind: "html", protocol: "query", rateLimit: "auth", handler: echo },
  { method: "GET", path: "/v1/admin/audit", auth: { kind: "admin" }, kind: "json", protocol: "header", rateLimit: "ip", handler: echo },
  { method: "PUT", path: "/v1/admin/settings", auth: { kind: "admin" }, kind: "json", protocol: "header", rateLimit: "ip", handler: echo },
];

/** The production table plus the probes (probes never shadow a production path). */
export const ALL_ROUTES: readonly Route[] = [
  ...ROUTES,
  ...PROBE_ROUTES.filter((p) => !ROUTES.some((r) => r.method === p.method && r.path === p.path)),
];

export function handler(deps: Partial<PipelineDeps> = {}, routes: readonly Route[] = ALL_ROUTES) {
  const fetch = createFetchHandler(routes, { now: () => NOW, ...deps });
  return async (request: Request, environment: Cloudflare.Env = env): Promise<Response> => {
    const exec = createExecutionContext();
    const res = await fetch(request, environment, exec);
    await waitOnExecutionContext(exec);
    return res;
  };
}

export async function errorCode(res: Response): Promise<string | null> {
  const ct = res.headers.get("Content-Type") ?? "";
  if (!ct.includes("json")) return (/Error code <code>([a-z_]+)<\/code>/.exec(await res.text()))?.[1] ?? null;
  return ((await res.json()) as { error?: { code?: string } }).error?.code ?? null;
}
