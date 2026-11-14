/**
 * Pins machine request signing (Design §7): the TS signer reproduces the committed
 * deterministic Ed25519 signatures, and the verifier runs every negative sequence in
 * `fixtures/sig/machine-request-negatives.json` against one in-memory nonce store.
 *
 * <module-headers:begin>
 * Uses:
 * test/sig.test.ts
 * ├── src/b64url.ts
 * ├── src/sig/canonical.ts
 * ├── src/sig/sign.ts
 * ├── src/sig/verify.ts
 * └── test/fixtures.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test)
 * <module-headers:end>
 */
import { describe, expect, it } from "vitest";
import { b64urlDecode } from "../src/b64url.ts";
import { EMPTY_BODY_SHA256, machineCanonical } from "../src/sig/canonical.ts";
import { signMachineRequest } from "../src/sig/sign.ts";
import { verifyMachineRequest, type MachineKey, type NonceStore } from "../src/sig/verify.ts";
import { fixture, hexToBytes, utf8 } from "./fixtures.ts";

const vectors = fixture("sig/machine-request.json");

describe("machine request signing", () => {
  it("names the empty-body hash", () => {
    expect(vectors.empty_body_sha256_hex).toBe(EMPTY_BODY_SHA256);
  });

  for (const r of vectors.requests) {
    it(`reproduces the ${r.name} signature byte for byte`, async () => {
      const privateKey = await crypto.subtle.importKey("pkcs8", hexToBytes(vectors.pkcs8_v1_hex), { name: "Ed25519" }, false, ["sign"]);
      const parts = { method: r.method, path: r.path, host: r.host, protocol: r.protocol, machineId: r.machine_id, body: utf8(r.body) };
      expect(await machineCanonical({ ...parts, timestamp: r.timestamp, nonce: r.nonce })).toBe(r.canonical);
      const headers = await signMachineRequest({ ...parts, privateKey, timestamp: r.timestamp, nonce: r.nonce });
      expect(headers).toEqual(r.headers);
    });
  }

  it("refuses to sign a path outside the machine path rule", async () => {
    const base = { method: "GET", host: "cp.example.com", protocol: "1", machineId: null, timestamp: "1", nonce: "AAAAAAAAAAAAAAAAAAAAAA", body: new Uint8Array() };
    await expect(machineCanonical({ ...base, path: "/v1/machine/config?x=1" })).rejects.toThrow();
    await expect(machineCanonical({ ...base, path: "/v1/machine" })).rejects.toThrow();
  });
});

describe("machine request verification", () => {
  const neg = fixture("sig/machine-request-negatives.json");
  const keyOf = (b64: string) => b64urlDecode(b64)!;
  const machines = new Map<string, MachineKey>(neg.machines.map((m: any) => [m.machine_id, { publicKey: keyOf(m.public_key), revoked: m.revoked }]));
  const codes = new Map<string, MachineKey>(neg.pair_codes.map((p: any) => [p.code, { publicKey: keyOf(p.public_key), revoked: false }]));

  for (const c of neg.cases) {
    it(c.name, async () => {
      const seen = new Set<string>();
      const nonces: NonceStore = {
        async recordIfNew(scope, nonce) {
          const k = `${scope}|${nonce}`;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        },
      };
      for (const req of c.requests) {
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) if (v !== null) headers.set(k, v as string);
        const result = await verifyMachineRequest({
          method: req.method,
          path: req.path,
          host: req.host,
          headers,
          body: utf8(req.body),
          now: req.now,
          protocol: neg.protocol,
          claimCode: req.claim_code,
          keys: { byMachineId: async (id) => machines.get(id) ?? null, byPairCode: async (code) => codes.get(code) ?? null },
          nonces,
        });
        if (req.expect.ok) expect(result.ok).toBe(true);
        else expect(result).toMatchObject({ ok: false, code: req.expect.code });
      }
    });
  }
});
