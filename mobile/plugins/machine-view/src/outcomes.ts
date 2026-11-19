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
 * - The direct-machine and share unions (G1, G5) carry no password, session, URI or file
 *   name; a share is a count plus an opaque batch id (random, non-secret, unrelated to the
 *   files, their names or any credential). Their `message` fields are the machine's own refusal sentence, untrusted text the
 *   native side bounds to 300 characters and strips of control characters; render it as text.
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
 * ├── test/contract.test.ts
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
  | { kind: "vault_locked" }
  /**
   * The key store or vault failed while the app was unlocked (a StrongBox/TEE provider error,
   * a tampered record, a save that failed). Only a locked vault is `vault_locked`.
   */
  | { kind: "secure_storage_failed" };

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
  /**
   * The host of the route the window was on when it closed; for `instance_changed`, the host
   * whose machine answered with another instance. Absent for `no_route` (no route was chosen)
   * and when the window never had a valid target. A public host name, never a credential.
   */
  host?: string;
  /** The first route's host of the open that made this window (the host an org or direct open named). */
  requestedHost?: string;
}

/**
 * `ClosedEvent.code` values a direct, routed or org window closes with (reason "error"): the
 * machine answering at the host is not the recorded instance, no route answered, or the
 * machine's yaran build is too old for the app to show its page (`upgrade_required`: its
 * status does not say `native_auth_ui: true`, so its page could ask for the password inside
 * the window; update yaran on that machine).
 */
export type DirectClosedCode = "instance_changed" | "no_route" | "upgrade_required";

/** Why a direct call was refused before or instead of reaching the machine. */
export type DirectRefusedReason = "invalid_host" | "org_host" | "response_too_large" | "not_json";

/** Failures every direct call shares; none means the machine was reached and answered. */
type DirectFailure =
  | { kind: "not_yaran" }
  /** A redirect to Cloudflare Access: add this machine through its organization instead. */
  | { kind: "access_required" }
  /** Any other redirect: never followed, nothing posted, no session attached. */
  | { kind: "redirected" }
  | { kind: "offline" }
  | { kind: "tls_error" }
  | { kind: "vault_locked" }
  /**
   * A yaran answered, but its build does not hand sign-in to the app (its status lacks
   * `native_auth_ui: true`): nothing is signed in, kept or shown. Update yaran on the machine.
   * A compatibility verdict only: `native_auth_ui` never authorizes anything.
   */
  | { kind: "upgrade_required" }
  | { kind: "refused"; reason: DirectRefusedReason };

/** `Session.directStatus`: the machine's public status document, or why there is none. */
export type DirectStatus =
  | {
      kind: "yaran";
      /** The machine's public instance id; null when it has none. Groups routes, authorizes nothing. */
      instance: string | null;
      passwordSet: boolean;
      requiredHere: boolean;
      signedIn: boolean;
      transportEncrypted: boolean;
    }
  | DirectFailure;

/**
 * `Session.routeStatus`: one route's public status, probed with that route's own native
 * credential only. A direct route answers exactly as `directStatus`. An org route is probed at
 * its exact host with its own `CF_Authorization`, redirects off; with no usable session there
 * (none, expired, or Access answered instead) it is `sign_in_required`: sign in with
 * `Session.signIn({orgId, target: {machineHost}})`, then probe again. A matching `instance`
 * groups routes the user approved; it authenticates nothing.
 */
export type RouteStatus = DirectStatus | { kind: "sign_in_required" };

/** `Session.directSignIn`: the native sheet's outcome. The server's sentences are relayed. */
export type DirectSignInOutcome =
  /**
   * `signInId` names this one sign-in: opaque, 22 base64url characters of randomness, never
   * derived from the session and no credential. Pass it to `directSignOut` to clean up only it.
   */
  | { kind: "signed_in"; host: string; instance: string | null; signInId: string }
  /** The machine lets this route in without a password; nothing was stored. */
  | { kind: "not_required" }
  | { kind: "cancelled" }
  | { kind: "wrong_password"; message: string }
  | { kind: "rate_limited"; retryAfterSeconds: number; message: string }
  | { kind: "no_password"; message: string }
  /** Any other refusal body (`password_changed`, `password_too_long`, blocked, internal). */
  | { kind: "server_refused"; status: number; code: string; message: string }
  /** The vault could not keep the session while unlocked; the machine's token was revoked. */
  | { kind: "secure_storage_failed" }
  | DirectFailure;

/** `Session.directSignOut`: the local session and web data are gone in every `signed_out`. */
export type DirectSignOutOutcome =
  | { kind: "signed_out"; serverEnded: boolean }
  /**
   * With a `signInId`: it is not the host's current sign-in, and nothing was ended or cleared.
   * Without one: sign-ins kept landing during the removal and the newest was kept, so the host
   * still has a session and the sign-out is incomplete.
   */
  | { kind: "not_current" }
  | { kind: "vault_locked" }
  /** The record could not be deleted while unlocked; the host's web data was still cleared. */
  | { kind: "secure_storage_failed" }
  | { kind: "refused"; reason: "invalid_host" };

/** `shareReceived`: another app shared to yaran. Emitted after unlock when the app lock is up. */
export type ShareReceivedEvent =
  /**
   * `count` files are held (at most MAX_SHARED_FILES); `dropped` were over the cap or not content.
   * `batch` names this share: an opaque, random, non-secret id, new for every share, that says
   * nothing about the files. Pass the batch you showed to `open({shareBatch})` or `discardShare`.
   */
  | { kind: "files"; count: number; dropped: number; batch: string }
  | { kind: "refused"; reason: ShareRefusedReason };

/** `no_files`: text or nothing shareable. `unsupported_os`: this OS cannot hand files to the page. */
export type ShareRefusedReason = "no_files" | "unsupported_os";

/** `MachineView.shareStatus`. `batch` is the held share's id (see `ShareReceivedEvent`). */
export type ShareStatus = { kind: "none" } | { kind: "pending"; count: number; batch: string };

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
    case "secure_storage_failed":
      break;
    default:
      return assertNever(outcome);
  }
  return { message: fill(row.message, local), action: row.action as FailureAction };
}
