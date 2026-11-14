/**
 * Route rows, handler context and the dependency bundle for every Phase 07 route.
 *
 * Rows use Phase 04's documented route-table shape (`method`, `path`, `auth`, `kind`,
 * `handler`) so 04's pipeline can append them as they are: 04 runs the host guard, rate
 * limits, the JSON content-type/Origin rule and the auth class, then calls `handler` with
 * the verified identity. `Phase07Deps` bundles the ports of 04, 05 and 06 this phase uses.
 *
 * - Types only.
 */
import type {
  AccessIdentityReader,
  AuditWriter,
  CfTransport,
  D1Like,
  DataKeySealer,
  Identity,
  PairingPort,
  ProvisioningPort,
  RateLimiter,
} from "../admin/ports.ts";

export type RouteAuth = { kind: "public" } | { kind: "setup" } | { kind: "user" } | { kind: "admin" };

export interface Phase07Env {
  SETUP_CODE?: string;
  DATA_KEY?: string;
  CF_API_TOKEN?: string;
}

export interface Phase07Deps {
  db: D1Like;
  env: Phase07Env;
  sealer: DataKeySealer;
  /** 04 `security/secrets.ts` DATA_KEY format check. */
  dataKeyValid(key: string): boolean;
  audit: AuditWriter;
  rateLimit: RateLimiter;
  accessIdentity: AccessIdentityReader;
  /** 05's client bound to an explicit token (the probe runs before the token is stored). */
  cfFor(token: string): CfTransport;
  provisioning: ProvisioningPort;
  pairing: PairingPort;
  fetch: typeof fetch;
  now(): Date;
  newId(): string;
  workerVersion: string;
}

export interface RouteCtx {
  request: Request;
  url: URL;
  params: Record<string, string>;
  /** Set for `user` and `admin` routes by 04's authorize step. */
  identity: Identity | null;
  deps: Phase07Deps;
  requestId: string;
}

export interface RouteRow {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  auth: RouteAuth;
  kind: "json" | "html";
  handler(ctx: RouteCtx): Promise<Response>;
}
