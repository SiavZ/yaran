/**
 * Pins the Web Push codec: RFC 8291 Appendix A byte for byte (IKM, CEK, nonce, body),
 * aes128gcm round trips at 1 and 3993 bytes with 3994 refused, tamper and delimiter
 * refusals, and RFC 8292 VAPID signing and verification against the shared vectors.
 *
 * <module-headers:begin>
 * Uses:
 * test/webpush.test.ts
 * ├── src/b64url.ts
 * ├── src/webpush/ece.ts
 * ├── src/webpush/vapid.ts
 * └── test/fixtures.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test in cloud/protocol and cloud-protocol.yml)
 * <module-headers:end>
 */
import { describe, expect, it } from "vitest";
import { b64urlDecode, b64urlEncode } from "../src/b64url.ts";
import { decryptWebPush, ECE_MAX_PLAINTEXT, encryptWebPush, generateEcdhKeyPair, importEcdhPrivate, webPushKeys } from "../src/webpush/ece.ts";
import { importVapidPrivateJwk, parseVapidHeader, signVapid, verifyVapid } from "../src/webpush/vapid.ts";
import { fixture } from "./fixtures.ts";

const d = (s: string) => b64urlDecode(s)!;
const rfc = fixture("webpush/rfc8291-appendix-a.json");

async function rfcSender() {
  return { privateKey: await importEcdhPrivate(d(rfc.as_private), d(rfc.as_public)), publicRaw: d(rfc.as_public) };
}

describe("RFC 8291 Appendix A", () => {
  it("derives the IKM, CEK and nonce", async () => {
    const keys = await webPushKeys(d(rfc.ecdh_secret), d(rfc.auth_secret), d(rfc.ua_public), d(rfc.as_public), d(rfc.salt));
    expect(b64urlEncode(keys.ikm)).toBe(rfc.ikm);
    expect(b64urlEncode(keys.cek)).toBe(rfc.cek);
    expect(b64urlEncode(keys.nonce)).toBe(rfc.nonce);
  });
  it("encrypts to the exact body", async () => {
    const body = await encryptWebPush(d(rfc.plaintext), d(rfc.ua_public), d(rfc.auth_secret), { salt: d(rfc.salt), asKeyPair: await rfcSender() });
    expect(b64urlEncode(body)).toBe(rfc.body);
  });
  it("decrypts the RFC body with the receiver key", async () => {
    const ua = await importEcdhPrivate(d(rfc.ua_private), d(rfc.ua_public));
    expect(b64urlEncode(await decryptWebPush(d(rfc.body), ua, d(rfc.ua_public), d(rfc.auth_secret)))).toBe(rfc.plaintext);
  });
});

describe("aes128gcm payload vectors", () => {
  const f = fixture("webpush/payload-vectors.json");
  for (const c of f.cases) {
    it(`${c.name} encrypts to the vector and decrypts back`, async () => {
      const body = await encryptWebPush(d(c.plaintext_b64url), d(f.ua_public), d(f.auth_secret), { salt: d(f.salt), asKeyPair: await rfcSender() });
      expect(b64urlEncode(body)).toBe(c.body_b64url);
      expect(body.length).toBe(c.body_bytes);
      const ua = await importEcdhPrivate(d(f.ua_private), d(f.ua_public));
      expect(b64urlEncode(await decryptWebPush(body, ua, d(f.ua_public), d(f.auth_secret)))).toBe(c.plaintext_b64url);
    });
  }
  it("refuses 3994 bytes", async () => {
    expect(ECE_MAX_PLAINTEXT).toBe(3993);
    await expect(encryptWebPush(new Uint8Array(3994), d(f.ua_public), d(f.auth_secret))).rejects.toThrow(/does not fit/);
  });
});

describe("decrypt refusals", () => {
  async function fresh(plaintext = new Uint8Array([1, 2, 3])) {
    const ua = await generateEcdhKeyPair();
    const auth = crypto.getRandomValues(new Uint8Array(16));
    return { ua, auth, body: await encryptWebPush(plaintext, ua.publicRaw, auth) };
  }
  it("round trips with a fresh sender key and salt every time", async () => {
    const { ua, auth, body } = await fresh();
    const again = await encryptWebPush(new Uint8Array([1, 2, 3]), ua.publicRaw, auth);
    expect(b64urlEncode(again)).not.toBe(b64urlEncode(body));
    expect([...(await decryptWebPush(body, ua.privateKey, ua.publicRaw, auth))]).toEqual([1, 2, 3]);
  });
  it("fails on a tampered tag", async () => {
    const { ua, auth, body } = await fresh();
    body[body.length - 1]! ^= 1;
    await expect(decryptWebPush(body, ua.privateKey, ua.publicRaw, auth)).rejects.toThrow();
  });
  it("fails when the delimiter is not 0x02", async () => {
    const ua = await importEcdhPrivate(d(rfc.ua_private), d(rfc.ua_public));
    // Re-seal the RFC plaintext with a 0x01 (non-last-record) delimiter under the RFC keys.
    const keys = await webPushKeys(d(rfc.ecdh_secret), d(rfc.auth_secret), d(rfc.ua_public), d(rfc.as_public), d(rfc.salt));
    const cek = await crypto.subtle.importKey("raw", keys.cek as BufferSource, "AES-GCM", false, ["encrypt"]);
    const padded = new Uint8Array([...d(rfc.plaintext), 1]);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: keys.nonce as BufferSource }, cek, padded));
    const body = new Uint8Array([...d(rfc.header), ...ct]);
    await expect(decryptWebPush(body, ua, d(rfc.ua_public), d(rfc.auth_secret))).rejects.toThrow(/0x02/);
  });
  it("fails with the wrong auth secret", async () => {
    const { ua, body } = await fresh();
    await expect(decryptWebPush(body, ua.privateKey, ua.publicRaw, new Uint8Array(16))).rejects.toThrow();
  });
});

describe("VAPID", () => {
  const v = fixture("webpush/vapid-vectors.json");
  const bound = d(v.bound_k);
  for (const c of v.cases) {
    it(`relay verdict: ${c.name}`, async () => {
      const verdict = await verifyVapid(c.authorization, { boundKey: bound, audience: v.audience, now: v.now });
      expect(verdict.ok ? "ok" : verdict.code).toBe(c.expect);
    });
  }
  it("signs a header the verifier accepts", async () => {
    const signer = await importVapidPrivateJwk(v.vapid_private_jwk);
    expect(b64urlEncode(signer.publicRaw)).toBe(v.vapid_public_key);
    const header = await signVapid(signer, { aud: v.audience, exp: v.now + 3600, sub: "https://cp.example.com" });
    const verdict = await verifyVapid(header, { boundKey: bound, audience: v.audience, now: v.now });
    expect(verdict).toEqual({ ok: true, claims: { aud: v.audience, exp: v.now + 3600, sub: "https://cp.example.com" } });
  });
  it("refuses a signature by another key presented under the bound k", async () => {
    const other = await generateEcdsa();
    const header = (await signVapid(other, { aud: v.audience, exp: v.now + 60 })).replace(/k=.*/, `k=${v.bound_k}`);
    expect(await verifyVapid(header, { boundKey: bound, audience: v.audience, now: v.now })).toEqual({ ok: false, code: "relay_vapid_invalid" });
  });
  it("parses parameters in either order and refuses junk", () => {
    expect(parseVapidHeader("Vapid k=abc, t=x.y.z")).toEqual({ jwt: "x.y.z", k: "abc" });
    expect(parseVapidHeader("WebPush x.y.z")).toBeNull();
    expect(parseVapidHeader("vapid t=a, t=b, k=c")).toBeNull();
    expect(parseVapidHeader("vapid t=a")).toBeNull();
  });
});

async function generateEcdsa() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  return { privateKey: pair.privateKey, publicRaw: new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)) };
}
