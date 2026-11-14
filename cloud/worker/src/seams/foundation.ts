/**
 * Phase 04 seam: the foundation interfaces Phase 06's routes consume, as 04's document
 * specifies them (router auth classes, identity, audit, rate limit, data key, errors).
 *
 * Phase 06 codes against these shapes because 04 is built concurrently. On integration
 * each declaration here is replaced by a re-export of 04's real module (named beside
 * it), and `errorResponse` by 04's `responses.error`.
 *
 * - Declarations only, plus one stand-in error builder over @yaran/protocol's envelope.
 * - Nothing here touches D1 or the network.
 *
 * <module-headers:begin>
 * Uses:
 * src/seams/foundation.ts
 * └── @yaran/protocol:src/index.ts
 * External: none
 *
 * Used by:
 * src/seams/foundation.ts
 * ├── src/cloudflare/access-sessions.ts
 * ├── src/devices/device-params.ts
 * ├── src/devices/devices-repo.ts
 * ├── src/devices/install-id.ts
 * ├── src/machine-api/claim.ts
 * ├── src/machine-api/config.ts
 * ├── src/machines/machine-rows.ts
 * ├── src/me/cursor.ts
 * ├── src/me/devices-route.ts
 * ├── src/me/machines-route.ts
 * ├── src/me/me-route.ts
 * ├── src/pairing/authorize-route.ts
 * ├── src/pairing/pair-requests.ts
 * ├── src/seams/context.ts
 * ├── src/sessions/handoff-csrf.ts
 * ├── src/sessions/handoff-remembered.ts
 * ├── src/sessions/handoff-route.ts
 * ├── src/sessions/revoke-sessions.ts
 * ├── src/shared/json-body.ts
 * ├── test/devices/device-params.test.ts
 * ├── test/phase06/fakes.ts
 * ├── test/phase06/harness.ts
 * └── test/sessions/revoke-sessions.test.ts
 * <module-headers:end>
 */
import { buildErrorEnvelope, type AuditAction, type ErrorCode, type Role } from "@yaran/protocol";

/** 04 `http/routes.ts` auth classes (04 design §2). */
export type RouteAuth =
  | { kind: "public" }
  | { kind: "setup" }
  | { kind: "machine"; key: "registered" | "pair_request" }
  | { kind: "user" }
  | { kind: "admin" };

/** 04 `security/rate-limit.ts` tier-1 bindings each route row names. */
export type RateBinding = "RL_IP" | "RL_AUTH" | "RL_MACHINE";

/** 04 `requireUser` output (`{email, sub, exp, role, status}`) plus the users row id and slug. */
export interface UserIdentity {
  userId: string;
  email: string;
  sub: string;
  /** The verified control-plane JWT's exp, Unix seconds. */
  exp: number;
  role: Role;
  slug: string;
}

/** 04 `auth/machine-signature.ts` result for a verified machine request (null id on W4). */
export interface MachineIdentity {
  id: string | null;
  protocol: number;
}

/** 04 `audit/audit.ts` `record()`; actions come from 02's registry. */
export interface AuditRecord {
  action: AuditAction;
  actor: { kind: "user" | "admin" | "machine" | "system"; id: string | null };
  target: { kind: "org" | "user" | "machine" | "device" | "settings"; id: string | null };
  outcome: "ok" | "denied" | "failed";
  errorCode?: ErrorCode;
  detail?: Record<string, unknown>;
}

export interface AuditWriter {
  record(r: AuditRecord): Promise<void>;
}

/** 04 tier-2 counter verdict. */
export type RateVerdict = { ok: true } | { ok: false; retryAfterS: number };

/** 04 `security/data-key.ts`: AES-GCM sealing with AAD and the consent MAC key. */
export type SealPurpose = "device_endpoint" | "device_auth" | "pair_state";
export interface DataKey {
  seal(purpose: SealPurpose, aad: string, plaintext: string): Promise<string>;
  open(purpose: SealPurpose, aad: string, sealed: string): Promise<string>;
  /** `macKey("handoff_consent") → {kv, key}`; kv is `data_key_state.version` (04 §7, D24). */
  macKey(purpose: "handoff_consent"): Promise<{ kv: number; key: Uint8Array }>;
}

/** 04 `http/context.ts` RequestContext, as far as Phase 06 reads it. */
export interface FoundationCtx {
  db: D1Database;
  /** Unix seconds; injected so tests control the clock. */
  now(): number;
  requestId: string;
  audit: AuditWriter;
  /** 04 tier-2 strict counter for a bucket Phase 06 declares (`PHASE06_RATE_BUCKETS`). */
  rateLimit(bucket: "pair" | "handoff", key: string): Promise<RateVerdict>;
  dataKey: DataKey;
}

/** 04's typed refusal; the pipeline turns it into the 02 envelope or error page. */
export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** Stand-in for 04 `responses.error`: the 02 envelope with its registry status. */
export function errorResponse(code: ErrorCode, message: string, requestId: string, details?: Record<string, unknown>): Response {
  const { status, body } = buildErrorEnvelope(code, message, requestId, details);
  const headers: Record<string, string> = { "Cache-Control": "no-store", "Yaran-Request-Id": requestId };
  if (status === 429 || status === 503) headers["Retry-After"] = String(details?.["retry_after_s"] ?? 60);
  return Response.json(body, { status, headers });
}
