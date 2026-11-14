/**
 * Phase 05 seam: the provisioning facade (`src/provisioning/index.ts`, 05 design §10)
 * and the Cloudflare client Phase 06 uses, with the request context already bound.
 *
 * 05 builds the saga concurrently; Phase 06 depends only on these signatures. On
 * integration the context binds 05's `(ctx, ...)` functions to this shape.
 *
 * - Declarations only.
 *
 * <module-headers:begin>
 * Uses:
 * src/seams/provisioning.ts
 * └── @yaran/protocol:src/index.ts
 * External: none
 *
 * Used by:
 * src/seams/provisioning.ts
 * ├── src/machines/machine-view-model.ts
 * ├── src/seams/context.ts
 * └── test/phase06/fakes.ts
 * <module-headers:end>
 */
import type { ErrorCode, TunnelCredentials } from "@yaran/protocol";

export interface OpRef {
  opId: string;
}

/** 05 `getOp`/`driveOp` view: state as 02's `AdminMachine.provisioning.state`. */
export interface OpView {
  state: "complete" | "in_progress" | "failed" | "compensating";
  /** The user-facing 02 code of a refusal (`account_quota_reached`, `cloudflare_*`, ...). */
  errorCode: ErrorCode | null;
  details?: Record<string, unknown>;
}

/** 04 `machines.revoke_reason` values. */
export type RevokeReason = "user_unpair" | "admin_revoke" | "machine_logout" | "user_disabled" | "stale" | "provision_failed";

export interface ProvisioningFacade {
  /** Idempotent saga keyed by machine id; returns the live op when one exists. */
  startProvision(machineId: string): Promise<OpRef>;
  driveOp(opId: string, budget: { wallMs: number; apiCalls: number }): Promise<OpView>;
  /** Guarded `→ revoking` transition plus the ordered teardown op (D21). */
  startTeardown(machineId: string, reason: RevokeReason): Promise<OpRef>;
  rotateTunnelSecret(machineId: string, o: { evict: boolean }): Promise<TunnelCredentials>;
  fetchTunnelToken(machineId: string): Promise<TunnelCredentials>;
  /** Throws `ApiError("provisioning_in_progress")` while another op is live. */
  setOriginPort(machineId: string, port: number): Promise<{ changed: boolean; op: OpRef | null }>;
}

/** 05 `src/cloudflare/client.ts` transport (budget, retries, envelope parsing). */
export interface CloudflareClient {
  call<T>(req: { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; path: string; body?: unknown; priority: "interactive" | "background" }): Promise<T>;
}
