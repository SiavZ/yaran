/**
 * The request context and route-row shape Phase 06's handlers take: 04's context plus
 * the 05 facade, 07's settings and the deploy variables, and 04's route-table row.
 *
 * On integration `RouteRow` becomes 04's row type and `Phase06Ctx` is built by 04's
 * pipeline from its own context; handlers keep their signature.
 *
 * - Declarations only.
 *
 * <module-headers:begin>
 * Uses:
 * src/seams/context.ts
 * ├── src/seams/console.ts
 * ├── src/seams/foundation.ts
 * └── src/seams/provisioning.ts
 * External: none
 *
 * Used by:
 * src/seams/context.ts
 * ├── src/cloudflare/access-sessions.ts
 * ├── src/devices/devices-repo.ts
 * ├── src/machine-api/claim.ts
 * ├── src/machine-api/config.ts
 * ├── src/machine-api/origin.ts
 * ├── src/machine-api/rotate.ts
 * ├── src/machine-api/unpair.ts
 * ├── src/me/devices-route.ts
 * ├── src/me/machines-route.ts
 * ├── src/me/me-route.ts
 * ├── src/pairing/authorize-route.ts
 * ├── src/pairing/sweep.ts
 * ├── src/routes/meta.ts
 * ├── src/routes/pairing-and-sessions.ts
 * ├── src/sessions/handoff-route.ts
 * ├── src/sessions/revoke-sessions.ts
 * ├── test/phase06/fakes.ts
 * └── test/phase06/harness.ts
 * <module-headers:end>
 */
import type { SettingsReader } from "./console.ts";
import type { FoundationCtx, MachineIdentity, RateBinding, RouteAuth, UserIdentity } from "./foundation.ts";
import type { CloudflareClient, ProvisioningFacade } from "./provisioning.ts";

/** Deploy variables Phase 06 reads (07 declares them in wrangler.jsonc). */
export interface Phase06Env {
  /** Space-separated https app callbacks a release build may receive a handoff on. */
  APP_CALLBACK_URLS: string;
  /** The Worker's own version, served as `Meta.worker.version`. */
  WORKER_VERSION?: string;
}

export interface Phase06Ctx extends FoundationCtx {
  provisioning: ProvisioningFacade;
  cloudflare: CloudflareClient;
  settings: SettingsReader;
  env: Phase06Env;
}

export interface RouteCall {
  req: Request;
  ctx: Phase06Ctx;
  params: Record<string, string>;
  /** Set by the pipeline for `user` and `admin` routes. */
  user: UserIdentity | null;
  /** Set by the pipeline for `machine` routes after the signature verified. */
  machine: MachineIdentity | null;
  /** The raw request body, read once (the signature covers these bytes). */
  body: Uint8Array;
}

export type Handler = (call: RouteCall) => Promise<Response>;

/** 04 `http/routes.ts` row: `{ method, path, auth, kind, handler, rateLimit, bodyLimit }`. */
export interface RouteRow {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  auth: RouteAuth;
  kind: "json" | "html";
  handler: Handler;
  rateLimit: RateBinding;
  bodyLimit: number;
}
