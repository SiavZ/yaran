/**
 * The seams Phase 07 consumes from Phases 04, 05 and 06, in one place.
 *
 * The wizard, the consoles and the admin API never reach into another phase's modules
 * directly; they receive these ports in `Phase07Deps`. Each port mirrors the interface the
 * owning phase's plan document specifies (04 storage, sealing, audit and route classes; 05
 * Cloudflare transport and teardown/rotation facade; 06 view models, device revocation and
 * session revocation). Where a document leaves a name unspecified, the name here is this
 * phase's proposal and is listed in the phase report for the integrator.
 *
 * - Types only, plus `assertNever`; no behaviour.
 * - D1 is described structurally so the real binding and the test shim both satisfy it.
 */
import type { AdminDevice, AdminDevicePage, AdminMachine, AdminMachinePage, AuditAction, Role } from "@yaran/protocol";

export interface D1Stmt {
  bind(...values: unknown[]): D1Stmt;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<{ meta: { changes: number } }>;
}

/** The subset of 04's D1 binding this phase uses. */
export interface D1Like {
  prepare(sql: string): D1Stmt;
  batch(statements: D1Stmt[]): Promise<unknown[]>;
}

/** 04 `security/data-key.ts`: AES-256-GCM sealing under a DATA_KEY-derived purpose key. */
export interface DataKeySealer {
  seal(purpose: string, aad: string, plaintext: string): Promise<string>;
  open(purpose: string, aad: string, sealed: string): Promise<string>;
}

export type AuditActorKind = "user" | "admin" | "system" | "setup";
export type AuditTargetKind = "org" | "user" | "machine" | "device" | "settings";

/** 04 `audit/audit.ts` `record(ctx, …)`, with the actor made explicit. */
export interface AuditInput {
  actor: { kind: AuditActorKind; id?: string };
  action: AuditAction;
  target: { kind: AuditTargetKind; id?: string };
  outcome: "ok" | "denied" | "failed";
  detail?: Record<string, unknown>;
}
export type AuditWriter = (entry: AuditInput) => Promise<void>;

/** 04 `security/rate-limit.ts`: true when the call is allowed. */
export type RateLimiter = (bucket: string, key: string) => Promise<boolean>;

/** 05 `cloudflare/errors.ts` `CfApiError.kind`. */
export type CfErrorKind = "rate_limited" | "transient" | "not_found" | "conflict" | "auth" | "invalid";

export interface CfApiErrorLike {
  kind: CfErrorKind;
  status: number;
  message: string;
}

export function isCfApiError(e: unknown): e is CfApiErrorLike {
  return typeof e === "object" && e !== null && "kind" in e && "status" in e;
}

/** 05 `cloudflare/client.ts`: one authenticated, budgeted, retrying call; returns `result`. */
export interface CfTransport {
  request<T>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T>;
}

/** 05 `provisioning/index.ts` facade, the calls the consoles make. */
export interface ProvisioningPort {
  startTeardown(machineId: string, reason: "admin_revoke" | "user_disabled" | "stale"): Promise<void>;
  rotateTunnelSecret(machineId: string, opts: { evict: boolean }): Promise<void>;
  /** Re-applies `session_duration` to the control-plane app and every machine app (budgeted job). */
  reapplySessionDuration(duration: string): Promise<void>;
  /** 05 `naming.ts` `deriveUserSlug`, for the admin row the claim inserts. */
  deriveUserSlug(email: string): string;
}

/** 06 view models and services the consoles reuse. */
export interface PairingPort {
  listMachines(q: { owner_user_id?: string; cursor?: string | null; limit: number }): Promise<AdminMachinePage>;
  listDevices(q: { owner_user_id?: string; cursor?: string | null; limit: number }): Promise<AdminDevicePage>;
  getMachine(id: string): Promise<AdminMachine | null>;
  getDevice(id: string): Promise<AdminDevice | null>;
  /** W11: a user's own unpair; "gone" when the machine no longer exists. */
  unpairMachine(userId: string, machineId: string): Promise<"started" | "gone">;
  /** W14/W24: removes a phone; "gone" when it no longer exists. */
  revokeDevice(deviceId: string, opts: { signOutEverywhere: boolean }): Promise<"revoked" | "gone">;
  revokeAllDevices(userId: string): Promise<void>;
  revokeUserSessions(email: string): Promise<void>;
  phoneQrSvg(orgUrl: string): string;
}

/** 04 `identity.ts` result for `user`/`admin` route classes. */
export interface Identity {
  user_id: string;
  email: string;
  role: Role;
}

/** 04 `auth/access-jwt.ts`: the verified Access identity on a request, or null. */
export type AccessIdentityReader = (request: Request) => Promise<{ email: string; sub: string } | null>;

export function assertNever(value: never): never {
  throw new Error(`unhandled case: ${String(value)}`);
}
