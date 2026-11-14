/**
 * The per-request context Phase 06's handlers receive: the request, its verified identity,
 * and the foundation (04), provisioning (05) and settings services bound to it.
 *
 * `routes/phase06-context.ts` builds it from 04's `RequestContext` and turns these rows
 * into 04 `Route` rows, so the route table, authorization and rate limiting stay 04's.
 *
 * - `FoundationCtx` is the subset repositories need, so they can be called from a cron
 *   task as well as a request.
 *
 * <module-headers:begin>
 * Uses:
 * src/routes/call.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/audit/audit.ts
 * ├── src/db/machines.ts
 * ├── src/env.ts
 * ├── src/http/routes.ts
 * └── src/security/data-key.ts
 * External: none
 *
 * Used by:
 * src/routes/call.ts
 * ├── src/cloudflare/access-sessions.ts
 * ├── src/devices/devices-repo.ts
 * ├── src/devices/install-id.ts
 * ├── src/machine-api/claim.ts
 * ├── src/machine-api/config.ts
 * ├── src/machine-api/origin.ts
 * ├── src/machine-api/rotate.ts
 * ├── src/machine-api/unpair.ts
 * ├── src/machines/machine-rows.ts
 * ├── src/machines/machine-view-model.ts
 * ├── src/me/devices-route.ts
 * ├── src/me/machines-route.ts
 * ├── src/me/me-route.ts
 * ├── src/pairing/authorize-route.ts
 * ├── src/pairing/pair-requests.ts
 * ├── src/pairing/sweep.ts
 * ├── src/routes/meta.ts
 * ├── src/routes/pairing-and-sessions.ts
 * ├── src/routes/phase06-context.ts
 * ├── src/sessions/handoff-csrf.ts
 * ├── src/sessions/handoff-remembered.ts
 * ├── src/sessions/handoff-route.ts
 * ├── src/sessions/revoke-sessions.ts
 * └── test/phase06/fakes.ts
 * <module-headers:end>
 */
import type { AuditAction, ErrorCode, Role, Settings, TunnelCredentials } from "@yaran/protocol";
import type { AuditTargetKind } from "../audit/audit.ts";
import type { Env } from "../env.ts";
import type { Method, ProtocolRule, RateBucket, RouteAuth } from "../http/routes.ts";
import type { RevokeReason } from "../db/machines.ts";
import type { MacPurpose, SealAad, SealPurpose } from "../security/data-key.ts";

/** The verified Access identity of a `user` or `admin` route. */
export interface UserIdentity {
  userId: string;
  email: string;
  sub: string;
  /** The verified control-plane JWT's exp, Unix seconds. */
  exp: number;
  role: Role;
  slug: string;
}

/** A verified machine request (null id on W4 claim). */
export interface MachineIdentity {
  id: string | null;
  protocol: number;
}

/** One audit row; the actor is explicit because a sweep acts as `system`. */
export interface AuditRecord {
  action: AuditAction;
  actor: { kind: "user" | "admin" | "machine" | "system"; id: string | null };
  target: { kind: AuditTargetKind; id: string | null };
  outcome: "ok" | "denied" | "failed";
  errorCode?: ErrorCode;
  detail?: Record<string, unknown>;
}

export type RateVerdict = { ok: true } | { ok: false; retryAfterS: number };

/** The org rows Phase 06 reads, null until setup writes them. */
export interface OrgSettings {
  setupState: "open" | "closed";
  controlPlaneHost: string | null;
  teamDomain: string | null;
  zoneName: string | null;
  accountId: string | null;
  /** 08's org VAPID public key, null while unset. */
  vapidPublicKey: string | null;
}

export interface FoundationCtx {
  db: D1Database;
  /** Unix seconds. */
  now(): number;
  requestId: string;
  audit: { record(r: AuditRecord): Promise<void> };
  /** A tier-2 counter for Phase 06's own buckets (`PHASE06_RATE_BUCKETS`). */
  rateLimit(bucket: "pair" | "handoff", key: string): Promise<RateVerdict>;
  dataKey: {
    seal(purpose: SealPurpose, aad: SealAad, plaintext: string): Promise<string>;
    open(purpose: SealPurpose, aad: SealAad, sealed: string): Promise<string>;
    macKey(purpose: MacPurpose): Promise<{ kv: number; key: Uint8Array }>;
  };
}

/** 05's op state as 02's `AdminMachine.provisioning.state`, with the refusal code. */
export interface OpView {
  state: "complete" | "in_progress" | "failed" | "compensating";
  errorCode: ErrorCode | null;
  /** The refusal's detail, when 05 recorded one (a quota refusal's resource, used and limit). */
  details?: Record<string, unknown>;
}

/** 05's provisioning facade bound to this request; refusals arrive as `HttpError`. */
export interface ProvisioningFacade {
  startProvision(machineId: string): Promise<{ opId: string }>;
  driveOp(opId: string, budget: { wallMs: number; apiCalls: number }): Promise<OpView>;
  startTeardown(machineId: string, reason: RevokeReason): Promise<{ opId: string }>;
  rotateTunnelSecret(machineId: string, o: { evict: boolean }): Promise<TunnelCredentials>;
  fetchTunnelToken(machineId: string): Promise<TunnelCredentials>;
  setOriginPort(machineId: string, port: number): Promise<{ changed: boolean }>;
}

export interface Phase06Ctx extends FoundationCtx {
  env: Env;
  provisioning: ProvisioningFacade;
  /** One Cloudflare API call through 05's client (budget, retries, envelope). */
  cloudflare: { call<T>(req: { method: Method; path: string; body?: unknown }): Promise<T> };
  settings: { read(): Promise<Settings>; internal(): Promise<OrgSettings> };
}

export interface RouteCall {
  req: Request;
  ctx: Phase06Ctx;
  params: Record<string, string>;
  /** Set for `user` and `admin` routes. */
  user: UserIdentity | null;
  /** Set for `machine` routes once the signature verified. */
  machine: MachineIdentity | null;
  /** The raw request body, read once (the signature covers these bytes). */
  body: Uint8Array;
}

export type Handler = (call: RouteCall) => Promise<Response>;

/** A 04 route row whose handler takes a `RouteCall`. */
export interface RouteRow {
  method: Method;
  path: string;
  auth: RouteAuth;
  kind: "json" | "html";
  protocol: ProtocolRule;
  rateLimit: RateBucket;
  bodyLimit: number;
  handler: Handler;
}
