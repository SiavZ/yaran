/**
 * PKCE S256 against RFC 7636 Appendix B and the code/token generator's shape.
 *
 * <module-headers:begin>
 * Uses:
 * test/pairing/pkce.test.ts
 * └── src/pairing/pkce.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test in cloud/worker (workerd, or Node for test/provisioning))
 * <module-headers:end>
 */
import { describe, expect, it } from "vitest";
import { randomToken, sha256Text, verifyS256 } from "../../src/pairing/pkce.ts";

describe("pkce", () => {
  it("verifies the RFC 7636 Appendix B vector", async () => {
    expect(await verifyS256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk", "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")).toBe(true);
  });
  it("refuses a different verifier, a short one and an empty challenge", async () => {
    expect(await verifyS256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXl", "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")).toBe(false);
    expect(await verifyS256("short", "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")).toBe(false);
    expect(await verifyS256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk", "")).toBe(false);
  });
  it("mints 43-character codes from 32 random bytes and hashes to 32 bytes", async () => {
    const a = randomToken(32);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(randomToken(32));
    expect((await sha256Text(a)).length).toBe(32);
  });
});
