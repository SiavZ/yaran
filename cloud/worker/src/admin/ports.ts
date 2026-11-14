/**
 * The services Phase 07's handlers receive in `Phase07Deps`, in one place: sealing, audit
 * and Access identity (04), a Cloudflare transport and the teardown and rotation facade
 * (05), and the machine and phone services (06). `routes/phase07-context.ts` builds them
 * from the real modules; tests use the same builder with only Cloudflare faked.
 *
 * - Types only, plus `assertNever`; no behaviour.
 *
 * <module-headers:begin>
 * Uses:
 * src/admin/ports.ts
 * ├── @yaran/protocol:src/index.ts
 * └── src/security/data-key.ts
 * External: none
 *
 * Used by:
 * src/admin/ports.ts
 * ├── src/admin/api-token.ts
 * ├── src/admin/pairing-service.ts
 * ├── src/admin/settings-apply.ts
 * ├── src/admin/users.ts
 * ├── src/cloudflare/setup-endpoints.ts
 * ├── src/console/admin-pages-2.tsx
 * ├── src/console/route-types.ts
 * ├── src/routes/phase07-context.ts
 * ├── src/setup/capability-probe.ts
 * ├── src/setup/routes.ts
 * ├── src/setup/steps/access.ts
 * ├── src/setup/steps/claim.ts
 * ├── src/setup/steps/domain.ts
 * ├── src/setup/steps/idp.ts
 * ├── src/setup/steps/keys.ts
 * ├── src/setup/steps/org.ts
 * ├── src/setup/steps/zone.ts
 * ├── src/setup/wizard-state.ts
 * ├── test/helpers/deps.ts
 * └── test/helpers/fake-cf.ts
 * <module-headers:end>
 */
import type { AdminDevice, AdminDevicePage, AdminMachine, AdminMachinePage, AuditAction, Role } from "@yaran/protocol";
import type { SealAad, SealPurpose } from "../security/data-key.ts";

/** 04 `security/data-key.ts`: AES-256-GCM sealing under a DATA_KEY-derived purpose key. */
export interface DataKeySealer {
  seal(purpose: SealPurpose, aad: SealAad, plaintext: string): Promise<string>;
  open(purpose: SealPurpose, aad: SealAad, sealed: string): Promise<string>;
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
  deriveUserSlug(email: string): Promise<string>;
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
