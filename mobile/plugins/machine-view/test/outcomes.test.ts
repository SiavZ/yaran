/**
 * The failure table: every SignInOutcome failure has exactly one sentence and one action.
 *
 * Pins `signInFailure` to `fixtures/messages.json` (the table the Kotlin and Swift twins are
 * pinned to as well) and checks that names are filled from the outcome first, then the caller.
 *
 * - Pure; the `kinds` list below is typed so a new variant without a row fails to compile.
 *
 * <module-headers:begin>
 * Uses:
 * test/outcomes.test.ts
 * ├── mobile/plugins/machine-view/fixtures/messages.json
 * └── src/outcomes.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test in mobile/plugins/machine-view)
 * <module-headers:end>
 */
import { describe, expect, it } from "vitest";
import messages from "../fixtures/messages.json" with { type: "json" };
import { assertNever, fill, signInFailure, type SignInOutcome } from "../src/outcomes.ts";

type Failure = Exclude<SignInOutcome, { kind: "signed_in" }>;
const samples: { [K in Failure["kind"]]: Extract<Failure, { kind: K }> } = {
  cancelled: { kind: "cancelled" },
  declined: { kind: "declined" },
  interrupted: { kind: "interrupted" },
  verification_failed: { kind: "verification_failed", domain: "app.example.com" },
  rate_limited: { kind: "rate_limited" },
  protocol_unsupported: { kind: "protocol_unsupported", min: 2, max: 3 },
  clock_skewed: { kind: "clock_skewed", serverTime: 1 },
  device_key_rejected: { kind: "device_key_rejected", code: "handoff_device_key_invalid", securityLevel: "tee" },
  refused: { kind: "refused", code: "handoff_request_invalid" },
  no_browser: { kind: "no_browser" },
  mismatch: { kind: "mismatch" },
  decrypt_failed: { kind: "decrypt_failed", code: "jwe_decrypt_failed" },
  envelope_expired: { kind: "envelope_expired" },
  not_owner: { kind: "not_owner", email: "ada@example.org" },
  offline: { kind: "offline" },
  tls_error: { kind: "tls_error" },
  vault_locked: { kind: "vault_locked" },
};

describe("signInFailure", () => {
  it("has a row for every failure kind and no row without a kind", () => {
    expect(Object.keys(messages.sign_in).sort()).toEqual(Object.keys(samples).sort());
  });

  it.each(Object.values(samples).map((o) => [o.kind, o] as const))("%s renders its row", (_, outcome) => {
    const { message, action } = signInFailure(outcome, { host: "laptop-ada.example.com", machine: "laptop", email: "x@y.z" });
    expect(message).not.toMatch(/\{(host|machine|email|domain|code)\}/);
    expect(action).toBe(messages.sign_in[outcome.kind].action);
  });

  it("fills names from the outcome before the caller's", () => {
    expect(signInFailure(samples.refused, { code: "ignored" }).message).toBe(
      "The sign-in page refused this request (handoff_request_invalid). Update the app.",
    );
    expect(signInFailure(samples.verification_failed, {}).message).toContain("for app.example.com.");
    expect(signInFailure({ kind: "not_owner" }, { email: "bob@example.org", machine: "laptop" }).message).toBe(
      "bob@example.org isn't the owner of laptop.",
    );
  });

  it("leaves an unknown placeholder alone and names a missing one", () => {
    expect(fill("{host} {nope}", {})).toBe("host {nope}");
  });

  it("assertNever throws on a value that escaped the type system", () => {
    expect(() => assertNever("x" as never)).toThrow(/unhandled variant/);
  });
});
