/**
 * Generates `fixtures/webpush/`: the RFC 8291 Appendix A vector (verbatim, re-derived
 * here and asserted step by step), aes128gcm payload-size vectors at 1, 320 and 3993
 * bytes with 3994 refused, and RFC 8292 VAPID cases for the relay (Design §9, §12).
 *
 * The RFC 8291 codec itself belongs to Phase 08 (src/webpush/); this file carries a
 * minimal independent encryptor only to produce and prove the vectors. VAPID JWTs are
 * ES256 (randomized), so committed tokens are kept while they still verify.
 *
 * <module-headers:begin>
 * Uses:
 * scripts/vectors/webpush.mjs
 * └── scripts/vectors/keys.mjs
 * External: node:crypto
 *
 * Used by:
 * scripts/vectors/webpush.mjs
 * └── scripts/gen-vectors.mjs
 * <module-headers:end>
 */
import { createCipheriv, createHmac, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { assertEq, b64u, ecdhZ, fromB64u, p256FromLabel } from "./keys.mjs";

const RFC = {
  plaintext: "V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24",
  as_public: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  as_private: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  ua_public: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  ua_private: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  auth_secret: "BTBZMqHH6r4Tts7J_aSIgg",
  ecdh_secret: "kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs",
  prk_key: "Snr3JMxaHVDXHWJn5wdC52WjpCtd2EIEGBykDcZW32k",
  key_info: "V2ViUHVzaDogaW5mbwAEJXGyvs3942BVGq8e0PTNNmwRzr5VX4m8t7GGpTM5FzFo7OLr4BhZe9MEebhuPI-OztV3ylkYfpJGmQ22ggCLDgT-M_SrDepxkU21WCP3O1SUj0EwbZIHMtu5pZpTKGSCIA5Zent7wmC6HCJ5mFgJkuk5cwAvMBKiiujwa7t45ewP",
  ikm: "S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg",
  prk: "09_eUZGrsvxChDCGRCdkLiDXrReGOEVeSCdCcPBSJSc",
  cek_info: "Q29udGVudC1FbmNvZGluZzogYWVzMTI4Z2NtAA",
  cek: "oIhVW04MRdy2XN9CiKLxTg",
  nonce_info: "Q29udGVudC1FbmNvZGluZzogbm9uY2UA",
  nonce: "4h_95klXJ5E_qnoN",
  header: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  padded_plaintext: "V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24C",
  ciphertext: "8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ",
};

const hmac = (key, data) => createHmac("sha256", key).update(data).digest();
const RS = 4096;

/** RFC 8291 §3.4 + RFC 8188 single-record aes128gcm encryption; returns every intermediate. */
function encrypt({ asPrivate, asPublic, uaPublic, salt, authSecret, plaintext }) {
  const ecdh = ecdhZ(asPrivate, uaPublic);
  const prkKey = hmac(authSecret, ecdh);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = hmac(prkKey, Buffer.concat([keyInfo, Buffer.of(1)]));
  const prk = hmac(salt, ikm);
  const cekInfo = Buffer.from("Content-Encoding: aes128gcm\0");
  const nonceInfo = Buffer.from("Content-Encoding: nonce\0");
  const cek = hmac(prk, Buffer.concat([cekInfo, Buffer.of(1)])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([nonceInfo, Buffer.of(1)])).subarray(0, 12);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(RS);
  const header = Buffer.concat([salt, rs, Buffer.of(asPublic.length), asPublic]);
  const padded = Buffer.concat([plaintext, Buffer.of(2)]);
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);
  if (header.length + ciphertext.length > RS) return null;
  return { ecdh, prkKey, keyInfo, ikm, prk, cekInfo, cek, nonceInfo, nonce, header, padded, ciphertext };
}

function rfc8291() {
  const r = encrypt({
    asPrivate: fromB64u(RFC.as_private),
    asPublic: fromB64u(RFC.as_public),
    uaPublic: fromB64u(RFC.ua_public),
    salt: fromB64u(RFC.salt),
    authSecret: fromB64u(RFC.auth_secret),
    plaintext: fromB64u(RFC.plaintext),
  });
  assertEq(b64u(ecdhZ(fromB64u(RFC.ua_private), fromB64u(RFC.as_public))), RFC.ecdh_secret, "RFC 8291 ecdh_secret (receiver side)");
  for (const [k, v] of Object.entries({ ecdh_secret: r.ecdh, prk_key: r.prkKey, key_info: r.keyInfo, ikm: r.ikm, prk: r.prk, cek_info: r.cekInfo, cek: r.cek, nonce_info: r.nonceInfo, nonce: r.nonce, header: r.header, padded_plaintext: r.padded, ciphertext: r.ciphertext })) {
    assertEq(b64u(v), RFC[k], `RFC 8291 Appendix A ${k}`);
  }
  return {
    source: "RFC 8291 Appendix A (https://www.rfc-editor.org/rfc/rfc8291#appendix-A), base64url values verbatim with whitespace removed; record size 4096",
    ...RFC,
    body: b64u(Buffer.concat([r.header, r.ciphertext])),
  };
}

function payloadVectors() {
  const inputs = { asPrivate: fromB64u(RFC.as_private), asPublic: fromB64u(RFC.as_public), uaPublic: fromB64u(RFC.ua_public), salt: fromB64u(RFC.salt), authSecret: fromB64u(RFC.auth_secret) };
  const plaintext = (n) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 31 + 7) & 0xff));
  const cases = [1, 320, 3993].map((n) => {
    const r = encrypt({ ...inputs, plaintext: plaintext(n) });
    return { name: `${n} bytes`, plaintext_b64url: b64u(plaintext(n)), body_b64url: b64u(Buffer.concat([r.header, r.ciphertext])), body_bytes: r.header.length + r.ciphertext.length };
  });
  if (encrypt({ ...inputs, plaintext: plaintext(3994) }) !== null) throw new Error("3994 bytes must not fit one 4096-byte record");
  return {
    description: "aes128gcm single-record bodies (rs 4096) with the RFC 8291 Appendix A keys, salt and auth secret; plaintext byte i is (31*i + 7) mod 256. 3994 bytes does not fit and must be refused.",
    as_public: RFC.as_public,
    as_private: RFC.as_private,
    ua_public: RFC.ua_public,
    ua_private: RFC.ua_private,
    salt: RFC.salt,
    auth_secret: RFC.auth_secret,
    record_size: RS,
    cases,
    refused: [{ name: "3994 bytes", plaintext_bytes: 3994 }],
  };
}

function vapid(ctx) {
  const prev = ctx.previous("webpush/vapid-vectors.json");
  const key = p256FromLabel("vapid/org");
  const other = p256FromLabel("vapid/other");
  const now = 1731571200;
  const aud = "https://relay.example.com";
  const sub = "https://cp.example.com";
  const token = (k, claims, name) => {
    const input = `${b64u(JSON.stringify({ typ: "JWT", alg: "ES256" }))}.${b64u(JSON.stringify(claims))}`;
    const old = prev?.cases?.find((c) => c.name === name)?.authorization.match(/t=([^,]+)/)?.[1];
    const pub = createPublicKey({ key: k.pubJwk, format: "jwk" });
    if (old?.startsWith(`${input}.`) && verify("sha256", Buffer.from(input), { key: pub, dsaEncoding: "ieee-p1363" }, fromB64u(old.split(".")[2]))) return old;
    const sig = sign("sha256", Buffer.from(input), { key: createPrivateKey({ key: k.jwk, format: "jwk" }), dsaEncoding: "ieee-p1363" });
    return `${input}.${b64u(sig)}`;
  };
  const c = (name, k, claims, expect) => ({ name, authorization: `vapid t=${token(k, claims, name)}, k=${k.pk}`, expect });
  return {
    description: "RFC 8292 VAPID as the relay checks it (Design §9): aud must be the relay origin, exp in the future and at most 24 h ahead, k must equal the key bound at mint. JWT signatures are committed once.",
    vapid_private_jwk: key.jwk,
    vapid_public_key: key.pk,
    bound_k: key.pk,
    audience: aud,
    now,
    cases: [
      c("valid", key, { aud, exp: now + 12 * 3600, sub }, "ok"),
      c("expired", key, { aud, exp: now - 1, sub }, "relay_vapid_invalid"),
      c("exp more than 24 h ahead", key, { aud, exp: now + 24 * 3600 + 1, sub }, "relay_vapid_invalid"),
      c("wrong aud", key, { aud: "https://other-relay.example.com", exp: now + 3600, sub }, "relay_vapid_invalid"),
      c("wrong k", other, { aud, exp: now + 3600, sub }, "relay_vapid_mismatch"),
      { name: "missing header", authorization: null, expect: "relay_vapid_invalid" },
    ],
  };
}

export async function generate(ctx) {
  return {
    "webpush/rfc8291-appendix-a.json": rfc8291(),
    "webpush/payload-vectors.json": payloadVectors(),
    "webpush/vapid-vectors.json": vapid(ctx),
  };
}
