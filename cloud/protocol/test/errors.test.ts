/**
 * Tests the error envelope builder and the client-side interpretation (Design §4):
 * status and retryability come from the registry, local/reserved/callback-only codes
 * never reach a body, and unknown codes fall back to the status class.
 *
 * <module-headers:begin>
 * Uses:
 * test/errors.test.ts
 * ├── src/errors.ts
 * └── src/validate.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test in cloud/protocol and cloud-protocol.yml)
 * <module-headers:end>
 */
import { describe, expect, it } from "vitest";
import { buildErrorEnvelope, errorEntry, interpretError } from "../src/errors.ts";
import { validate } from "../src/validate.ts";

describe("error envelope", () => {
  it("builds a schema-valid envelope with the registry's status and retryability", () => {
    const { status, body } = buildErrorEnvelope("signature_expired", "The clock is 412 s off.", "8d1f2c3b4a5e6f70-LHR", {
      server_time: "2026-11-14T12:00:00Z",
    });
    expect(status).toBe(401);
    expect(body.error.retryable).toBe(false);
    expect(validate("ErrorEnvelope", body).valid).toBe(true);
    expect(buildErrorEnvelope("rate_limited", "Slow down.", "r1").body.error.retryable).toBe(true);
  });

  it("refuses codes that must never be sent in a body", () => {
    for (const code of ["jwe_malformed", "handoff_declined", "handoff_jwt_missing"] as const) {
      expect(() => buildErrorEnvelope(code, "x", "r1")).toThrow();
    }
  });

  it("interprets a known code as-is", () => {
    const body = buildErrorEnvelope("machine_revoked", "Revoked.", "r2").body;
    expect(interpretError(410, body)).toMatchObject({ code: "machine_revoked", retryable: false, requestId: "r2" });
  });

  it("falls back to the status class for an unknown code or a bad body", () => {
    const future = { error: { code: "brand_new_code", message: "x", retryable: false }, request_id: "r3" };
    expect(interpretError(503, future)).toMatchObject({ code: "unknown", rawCode: "brand_new_code", retryable: true });
    expect(interpretError(400, future)).toMatchObject({ code: "unknown", retryable: false });
    expect(interpretError(429, "not json")).toMatchObject({ code: "unknown", retryable: true, requestId: null });
  });

  it("does not trust a local code arriving over HTTP", () => {
    const body = { error: { code: "jwe_expired", message: "x", retryable: true }, request_id: "r4" };
    expect(interpretError(400, body).code).toBe("unknown");
    expect(errorEntry("jwe_expired")?.local).toBe(true);
  });
});
