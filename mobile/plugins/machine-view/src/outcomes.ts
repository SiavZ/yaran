/**
 * Exhaustive result unions of the machine-view plugin, and the one place they become words.
 *
 * `SignInOutcome` is what `Session.signIn` resolves with, `ApiResult` what `Session.request`
 * and `Session.meta` resolve with, and `ClosedEvent` what the machine window emits when it
 * goes away. Every variant is a `kind`-tagged object, so a `switch` over `kind` that ends in
 * `assertNever` stops compiling when a variant is added. The sentences and actions come from
 * the shared table `fixtures/messages.json`, which the Kotlin and Swift twins are pinned to.
 *
 * - Pure: no Capacitor, no I/O.
 * - No variant carries a JWT, cookie or key (D22); `api_error` carries the Phase 02 envelope.
 *
 * <module-headers:begin>
 * Uses:
 * src/outcomes.ts
 * ├── @yaran/protocol:src/index.ts
 * └── mobile/plugins/machine-view/fixtures/messages.json
 * External: none
 *
 * Used by:
 * src/outcomes.ts
 * ├── src/definitions.ts
 * ├── src/index.ts
 * ├── src/openMachine.ts
 * └── test/outcomes.test.ts
 * <module-headers:end>
 */
import type { ErrorEnvelope } from "@yaran/protocol";
import messages from "../fixtures/messages.json" with { type: "json" };

/** Where a device key lives; reported in diagnostics and on a refused device key. */
export type SecurityLevel = "strongbox" | "tee" | "secure_enclave" | "software";

export type SignInOutcome =
  | { kind: "signed_in"; host: string; email: string; expiresAt: number }
  | { kind: "cancelled" }
  | { kind: "declined" }
  | { kind: "interrupted" }
  | { kind: "verification_failed"; domain: string }
  | { kind: "rate_limited" }
  | { kind: "protocol_unsupported"; min?: number; max?: number }
  | { kind: "clock_skewed"; serverTime?: number }
  | { kind: "device_key_rejected"; code: string; securityLevel: SecurityLevel }
  | { kind: "refused"; code: string }
  | { kind: "no_browser" }
  | { kind: "mismatch" }
  | { kind: "decrypt_failed"; code: string }
  | { kind: "envelope_expired" }
  | { kind: "not_owner"; email?: string }
  | { kind: "offline" }
  | { kind: "tls_error" }
  | { kind: "vault_locked" };

/** Why the native client refused a request before (or instead of) answering it. */
export type RefusedReason =
  | "unknown_org"
  | "origin"
  | "method"
  | "path"
  | "body_invalid"
  | "body_install_id"
  | "body_device_key"
  | "response_too_large"
  | "not_json";

export type ApiResult =
  | { kind: "ok"; status: number; body: unknown }
  | { kind: "api_error"; status: number; error: ErrorEnvelope }
  | { kind: "session_expired" }
  | { kind: "device_revoked" }
  | { kind: "offline" }
  | { kind: "tls_error" }
  | { kind: "refused"; reason: RefusedReason }
  | { kind: "protocol_unsupported"; min?: number; max?: number };

export type ClosedReason = "user" | "home" | "settings" | "signedOut" | "error";

export interface ClosedEvent {
  reason: ClosedReason;
  /** A stable code (registry or plugin) when reason is "error". */
  code?: string;
}

export type FailureAction =
  | "try_again"
  | "back"
  | "open_settings"
  | "back_to_machines"
  | "add_org"
  | "retry"
  | "unlock"
  | "sign_in"
  | "renew";

export function assertNever(value: never): never {
  throw new Error(`unhandled variant ${JSON.stringify(value)}`);
}

/** Placeholder values a sentence may name; missing ones render as the key's own name. */
export interface MessageVars {
  host?: string;
  machine?: string;
  email?: string;
  domain?: string;
  code?: string;
}

export function fill(template: string, vars: MessageVars): string {
  return template.replace(/\{(host|machine|email|domain|code)\}/g, (_, k: keyof MessageVars) => vars[k] ?? k);
}

type FailureKind = Exclude<SignInOutcome["kind"], "signed_in">;
const SIGN_IN: Record<FailureKind, { message: string; action: string }> = messages.sign_in;

/** The sentence and the one action for a failed sign-in (the failure matrix). */
export function signInFailure(
  outcome: Exclude<SignInOutcome, { kind: "signed_in" }>,
  vars: MessageVars,
): { message: string; action: FailureAction } {
  const row = SIGN_IN[outcome.kind];
  const local: MessageVars = { ...vars };
  switch (outcome.kind) {
    case "verification_failed":
      local.domain = outcome.domain;
      break;
    case "device_key_rejected":
    case "refused":
    case "decrypt_failed":
      local.code = outcome.code;
      break;
    case "not_owner":
      if (outcome.email) local.email = outcome.email;
      break;
    case "cancelled":
    case "declined":
    case "interrupted":
    case "rate_limited":
    case "protocol_unsupported":
    case "clock_skewed":
    case "no_browser":
    case "mismatch":
    case "envelope_expired":
    case "offline":
    case "tls_error":
    case "vault_locked":
      break;
    default:
      return assertNever(outcome);
  }
  return { message: fill(row.message, local), action: row.action as FailureAction };
}
