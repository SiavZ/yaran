/**
 * Pins the sealed envelope (Design §8): the RFC 7518 App. C and RFC 7520 §5.5 Concat KDF
 * vectors, deterministic sealing to the committed handoff vectors, opening them, every
 * invalid vector failing with its named code, and a seal -> open round trip over fresh
 * random keys.
 *
 * <module-headers:begin>
 * Uses:
 * test/jwe.test.ts
 * ├── src/b64url.ts
 * ├── src/jwe/ec.ts
 * ├── src/jwe/handoff.ts
 * ├── src/jwe/kdf.ts
 * └── test/fixtures.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test)
 * <module-headers:end>
 */
import { describe, expect, it } from "vitest";
import { b64urlEncode, toHex } from "../src/b64url.ts";
import { decodeP256Point, jwkThumbprint, pointToJwk } from "../src/jwe/ec.ts";
import { importRecipientPrivateJwk, openHandoff, sealHandoff } from "../src/jwe/handoff.ts";
import { concatKdf, concatKdfOtherInfo } from "../src/jwe/kdf.ts";
import { fixture, fixturePaths, hexToBytes, utf8 } from "./fixtures.ts";

describe("Concat KDF", () => {
  for (const path of ["jwe/kdf-rfc7518-appendix-c.json", "jwe/kdf-rfc7520-5.5.json"]) {
    it(path, async () => {
      const v = fixture(path);
      const apu = utf8(v.apu_utf8);
      const apv = utf8(v.apv_utf8);
      expect(toHex(concatKdfOtherInfo(v.enc, apu, apv, v.keydatalen))).toBe(v.other_info_hex);
      const key = await concatKdf(hexToBytes(v.z_hex), v.enc, apu, apv, v.keydatalen);
      expect(toHex(key)).toBe(v.k_hex ?? v.cek_hex);
    });
  }

  it("matches the RFC 7518 App. C value as printed", async () => {
    const v = fixture("jwe/kdf-rfc7518-appendix-c.json");
    expect(b64urlEncode(await concatKdf(hexToBytes(v.z_hex), "A128GCM", utf8("Alice"), utf8("Bob"), 128))).toBe("VqqN6vgjbSBcIijNcacQGg");
  });
});

describe("handoff envelope v1", () => {
  for (const name of ["machine", "control-plane"]) {
    const v = fixture(`jwe/handoff-v1-valid-${name}.json`);
    it(`seals the ${name} vector deterministically`, async () => {
      const jwe = await sealHandoff({
        recipientPk: v.recipient_pk,
        host: v.expected_host,
        state: v.expected_state,
        payload: v.plaintext,
        testOnly: { epkPrivateJwk: v.ephemeral_jwk, iv: Uint8Array.from(Buffer.from(v.iv_b64url, "base64url")) },
      });
      expect(jwe).toBe(v.compact_jwe);
      expect(await jwkThumbprint(pointToJwk(decodeP256Point(v.recipient_pk)!))).toBe(v.kid);
    });

    it(`opens the ${name} vector`, async () => {
      const result = await openHandoff({
        jwe: v.compact_jwe,
        recipientPrivateKey: await importRecipientPrivateJwk(v.recipient_jwk),
        recipientPk: v.recipient_pk,
        expectedHost: v.expected_host,
        expectedState: v.expected_state,
        expectedKind: v.expected_kind,
        now: v.now,
      });
      expect(result).toMatchObject({ ok: true, payload: v.plaintext });
    });
  }

  for (const path of fixturePaths("jwe", "handoff-v1-invalid-")) {
    const v = fixture(path);
    it(`${path} fails with ${v.expect_code}`, async () => {
      const result = await openHandoff({
        jwe: v.compact_jwe,
        recipientPrivateKey: await importRecipientPrivateJwk(v.recipient_jwk),
        recipientPk: v.recipient_pk,
        expectedHost: v.expected_host,
        expectedState: v.expected_state,
        expectedKind: v.expected_kind,
        now: v.now,
      });
      expect(result).toEqual({ ok: false, code: v.expect_code });
    });
  }

  it("round-trips seal -> open for fresh random keys", async () => {
    for (let i = 0; i < 8; i++) {
      const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
      const pk = b64urlEncode(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
      const state = b64urlEncode(crypto.getRandomValues(new Uint8Array(24)));
      const payload = { v: 1 as const, kind: "control_plane" as const, host: "cp.example.com", jwt: "a.b.c", email: "ada@example.org", exp: 2_000_000_000, iat: 1_900_000_000 };
      const jwe = await sealHandoff({ recipientPk: pk, host: payload.host, state, payload });
      const opened = await openHandoff({
        jwe,
        recipientPrivateKey: pair.privateKey,
        recipientPk: pk,
        expectedHost: payload.host,
        expectedState: state,
        expectedKind: "control_plane",
        now: 1_900_000_000,
      });
      expect(opened).toMatchObject({ ok: true, payload });
    }
  });

  it("refuses to seal a payload whose host is not the sealer's", async () => {
    const v = fixture("jwe/handoff-v1-valid-machine.json");
    await expect(sealHandoff({ recipientPk: v.recipient_pk, host: "cp.example.com", state: v.expected_state, payload: v.plaintext })).rejects.toThrow();
  });
});

describe("P-256 points", () => {
  it("rejects compressed, short and off-curve points", () => {
    const v = fixture("jwe/handoff-v1-valid-machine.json");
    const raw = decodeP256Point(v.recipient_pk)!;
    expect(raw).not.toBeNull();
    const off = raw.slice();
    off[64]! ^= 1;
    expect(decodeP256Point(b64urlEncode(off))).toBeNull();
    expect(decodeP256Point(b64urlEncode(raw.subarray(0, 33)))).toBeNull();
    expect(decodeP256Point(`${v.recipient_pk}A`)).toBeNull();
  });
});
