/**
 * UNVERIFIED-1 (left by Phase 02): workerd imports a raw 32-byte Ed25519 public key and
 * verifies a Phase 02 fixture signature with it, so the machine verifier needs no JWK
 * fallback. Runs under workerd through the Cloudflare Vitest plugin, never live Cloudflare.
 *
 * <module-headers:begin>
 * Uses:
 * test/ed25519.test.ts
 * ├── @yaran/protocol:src/index.ts
 * └── cloud/protocol/fixtures/sig/machine-request.json
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test in cloud/worker (workerd, or Node for test/provisioning))
 * <module-headers:end>
 */
import { b64urlDecode } from "@yaran/protocol";
import fx from "@yaran/protocol/fixtures/sig/machine-request.json";
import { describe, expect, it } from "vitest";

describe("UNVERIFIED-1: raw Ed25519 import in workerd", () => {
  it("runs inside workerd", () => {
    expect(navigator.userAgent).toBe("Cloudflare-Workers");
  });
  it.each(fx.requests.map((r) => [r.name, r] as const))("verifies the %s fixture signature", async (_n, r) => {
    const key = await crypto.subtle.importKey("raw", b64urlDecode(fx.public_key)!, { name: "Ed25519" }, false, ["verify"]);
    const ok = await crypto.subtle.verify({ name: "Ed25519" }, key, b64urlDecode(r.signature)!, new TextEncoder().encode(r.canonical));
    expect(ok).toBe(true);
    const tampered = new TextEncoder().encode(`${r.canonical}x`);
    expect(await crypto.subtle.verify({ name: "Ed25519" }, key, b64urlDecode(r.signature)!, tampered)).toBe(false);
  });
});
