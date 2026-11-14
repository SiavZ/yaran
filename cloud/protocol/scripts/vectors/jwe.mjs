/**
 * Generates `fixtures/jwe/`: the RFC 7518 Appendix C and RFC 7520 §5.5 Concat KDF vectors
 * (asserted against the RFC text), and the `yaran-handoff+jwe` v1 valid and invalid
 * envelopes every opener must agree on (Design §8, §12).
 *
 * Handoff envelopes are sealed with jose using a fixed ephemeral key and IV; Z and the CEK
 * are recomputed with node:crypto and the result is opened again with jose, so a vector
 * is only written when three implementations agree.
 *
 * <module-headers:begin>
 * Uses:
 * scripts/vectors/jwe.mjs
 * └── scripts/vectors/keys.mjs
 * External: jose
 *
 * Used by:
 * scripts/vectors/jwe.mjs
 * └── scripts/gen-vectors.mjs
 * <module-headers:end>
 */
import { CompactEncrypt, compactDecrypt, importJWK } from "jose";
import { assertEq, b64u, concatKdf, ecdhZ, fromB64u, hex, otherInfo, p256FromLabel, sha256 } from "./keys.mjs";

const enc = new TextEncoder();

async function rfc7518AppendixC() {
  const alice = { kty: "EC", crv: "P-256", x: "gI0GAILBdu7T53akrFmMyGcsF3n5dO7MmwNBHKW5SV0", y: "SLW_xSffzlPWrHEVI30DHM_4egVwt3NQqeUD7nMFpps", d: "0_NxaRPUMQoAJt50Gz8YiTr8gRTwyEaCumd-MToTmIo" };
  const bob = { kty: "EC", crv: "P-256", x: "weNJy2HscCSM6AEDTDg04biOvhFhyyWvOHQfeF_PxMQ", y: "e8lnCO-AlStT-NJVX-crhB7QRYhiix03illJOVAOyck", d: "VEmDZpDXXK8p8N0Cndsxs924q6nS1RXFASRl6BfUqdw" };
  const rfcZ = Buffer.from([158, 86, 217, 29, 129, 113, 53, 211, 114, 131, 66, 131, 191, 132, 38, 156, 251, 49, 110, 163, 218, 128, 106, 72, 246, 218, 167, 121, 140, 254, 144, 196]);
  const alicePub = Buffer.concat([Buffer.of(4), fromB64u(alice.x), fromB64u(alice.y)]);
  const z = ecdhZ(fromB64u(bob.d), alicePub);
  assertEq(hex(z), hex(rfcZ), "RFC 7518 App. C Z");
  const k = concatKdf(z, "A128GCM", "Alice", "Bob", 128);
  assertEq(b64u(k), "VqqN6vgjbSBcIijNcacQGg", "RFC 7518 App. C K");
  return {
    source: "RFC 7518 Appendix C (https://www.rfc-editor.org/rfc/rfc7518#appendix-C)",
    ephemeral_jwk: alice,
    recipient_jwk: bob,
    enc: "A128GCM",
    apu_utf8: "Alice",
    apv_utf8: "Bob",
    keydatalen: 128,
    z_hex: hex(z),
    other_info_hex: hex(otherInfo("A128GCM", "Alice", "Bob", 128)),
    k_b64url: b64u(k),
    k_hex: hex(k),
  };
}

const RFC7520_PLAINTEXT =
  "You can trust us to stick with you through thick and thin–to the bitter end. And you can trust us to keep any secret of yours–closer than you keep it yourself. But you cannot trust us to let you face trouble alone, and go off without a word. We are your friends, Frodo.";

async function rfc7520Section55() {
  const recipient = { kty: "EC", kid: "meriadoc.brandybuck@buckland.example", use: "enc", crv: "P-256", x: "Ze2loSV3wrroKUN_4zhwGhCqo3Xhu1td4QjeQ5wIVR0", y: "HlLtdXARY_f55A3fnzQbPcm6hgr34Mp8p-nuzQCE0Zw", d: "r_kHyZ-a06rmxM3yESK84r1otSg-aQcVStkRhA-iCM8" };
  const ephemeral = { kty: "EC", crv: "P-256", x: "mPUKT_bAWGHIhg0TpjjqVsP1rXWQu_vwVOHHtNkdYoA", y: "8BQAsImGeAS46fyWw5MhYfGTT0IjBpFw2SS34Dv4Irs", d: "AtH35vJsQ9SGjYfOsjUxYXQKrPH3FjZHmEtSKoSN8cM" };
  const header =
    "eyJhbGciOiJFQ0RILUVTIiwia2lkIjoibWVyaWFkb2MuYnJhbmR5YnVja0BidWNrbGFuZC5leGFtcGxlIiwiZXBrIjp7Imt0eSI6IkVDIiwiY3J2IjoiUC0yNTYiLCJ4IjoibVBVS1RfYkFXR0hJaGcwVHBqanFWc1AxclhXUXVfdndWT0hIdE5rZFlvQSIsInkiOiI4QlFBc0ltR2VBUzQ2ZnlXdzVNaFlmR1RUMElqQnBGdzJTUzM0RHY0SXJzIn0sImVuYyI6IkExMjhDQkMtSFMyNTYifQ";
  const compact = [
    header,
    "",
    "yc9N8v5sYyv3iGQT926IUg",
    "BoDlwPnTypYq-ivjmQvAYJLb5Q6l-F3LIgQomlz87yW4OPKbWE1zSTEFjDfhU9IPIOSA9Bml4m7iDFwA-1ZXvHteLDtw4R1XRGMEsDIqAYtskTTmzmzNa-_q4F_evAPUmwlO-ZG45Mnq4uhM1fm_D9rBtWolqZSF3xGNNkpOMQKF1Cl8i8wjzRli7-IXgyirlKQsbhhqRzkv8IcY6aHl24j03C-AR2le1r7URUhArM79BY8soZU0lzwI-sD5PZ3l4NDCCei9XkoIAfsXJWmySPoeRb2Ni5UZL4mYpvKDiwmyzGd65KqVw7MsFfI_K767G9C9Azp73gKZD0DyUn1mn0WW5LmyX_yJ-3AROq8p1WZBfG-ZyJ6195_JGG2m9Csg",
    "WCCkNa-x4BeB9hIDIfFuhg",
  ].join(".");
  const recipientPub = Buffer.concat([Buffer.of(4), fromB64u(recipient.x), fromB64u(recipient.y)]);
  const z = ecdhZ(fromB64u(ephemeral.d), recipientPub);
  const cek = concatKdf(z, "A128CBC-HS256", "", "", 256);
  assertEq(b64u(cek), "hzHdlfQIAEehb8Hrd_mFRhKsKLEzPfshfXs9l6areCc", "RFC 7520 §5.5 CEK (Figure 123)");
  const opened = await compactDecrypt(compact, await importJWK(recipient, "ECDH-ES"));
  assertEq(Buffer.from(opened.plaintext).toString("utf8"), RFC7520_PLAINTEXT, "RFC 7520 §5.5 plaintext via jose");
  return {
    source: "RFC 7520 §5.5 (https://www.rfc-editor.org/rfc/rfc7520#section-5.5); cek_hex is Figure 123, z_hex and other_info_hex are derived",
    recipient_jwk: recipient,
    ephemeral_jwk: ephemeral,
    protected_header_b64url: header,
    compact_jwe: compact,
    plaintext_utf8: RFC7520_PLAINTEXT,
    enc: "A128CBC-HS256",
    apu_utf8: "",
    apv_utf8: "",
    keydatalen: 256,
    z_hex: hex(z),
    other_info_hex: hex(otherInfo("A128CBC-HS256", "", "", 256)),
    cek_hex: hex(cek),
  };
}

const NOW = 1731571500;
const FAKE_JWT = `${b64u(JSON.stringify({ alg: "RS256", kid: "fixture-kid" }))}.${b64u(JSON.stringify({ aud: ["fixture-aud"], email: "ada@example.org", exp: 1731657600 }))}.${b64u("fixture-signature")}`;

const CASES = {
  machine: { host: "laptop-ada.example.com", state: b64u("handoff-state-fixture-machine"), kind: "machine", cookie: FAKE_JWT },
  "control-plane": { host: "cp.example.com", state: b64u("handoff-state-fixture-control-plane"), kind: "control_plane" },
};

function thumbprint(pubJwk) {
  return b64u(sha256(`{"crv":"P-256","kty":"EC","x":"${pubJwk.x}","y":"${pubJwk.y}"}`));
}

async function seal({ recipient, epk, iv, host, state, payload, header = {} }) {
  const pub = await importJWK(recipient.pubJwk, "ECDH-ES");
  const ephemeral = await crypto.subtle.importKey("jwk", epk.jwk, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  return new CompactEncrypt(enc.encode(JSON.stringify(payload)))
    .setProtectedHeader({ alg: "ECDH-ES", enc: "A256GCM", typ: "yaran-handoff+jwe", cty: "yaran-handoff+json", kid: thumbprint(recipient.pubJwk), ...header })
    .setKeyManagementParameters({ apu: enc.encode(host), apv: enc.encode(state), epk: ephemeral })
    .setInitializationVector(iv)
    .encrypt(pub);
}

function payloadFor(c, overrides = {}) {
  const p = { v: 1, kind: c.kind, host: c.host, jwt: FAKE_JWT, email: "ada@example.org", exp: 1731657600, iat: 1731571200 };
  if (c.cookie) p.cookie = c.cookie;
  return { ...p, ...overrides };
}

async function validHandoff(name) {
  const c = CASES[name];
  const recipient = p256FromLabel(`handoff/recipient/${name}`);
  const epk = p256FromLabel(`handoff/ephemeral/${name}`);
  const iv = sha256(`yaran-fixture/handoff/iv/${name}`).subarray(0, 12);
  const payload = payloadFor(c);
  const jwe = await seal({ recipient, epk, iv, host: c.host, state: c.state, payload });
  const z = ecdhZ(epk.d, recipient.raw);
  assertEq(hex(z), hex(ecdhZ(recipient.d, epk.raw)), "ECDH symmetry");
  const cek = concatKdf(z, "A256GCM", c.host, c.state, 256);
  const opened = await compactDecrypt(jwe, await importJWK(recipient.jwk, "ECDH-ES"));
  assertEq(Buffer.from(opened.plaintext).toString(), JSON.stringify(payload), `jose reopens ${name}`);
  const [h, , , ct, tag] = jwe.split(".");
  return {
    file: {
      description: `A valid yaran-handoff+jwe v1 envelope (kind ${c.kind}); seal deterministically with ephemeral_jwk and iv_b64url.`,
      recipient_jwk: recipient.jwk,
      recipient_pk: recipient.pk,
      ephemeral_jwk: epk.jwk,
      iv_b64url: b64u(iv),
      expected_host: c.host,
      expected_state: c.state,
      expected_kind: c.kind,
      now: NOW,
      plaintext: payload,
      plaintext_utf8: JSON.stringify(payload),
      protected_header_json: Buffer.from(h, "base64url").toString(),
      protected_header_b64url: h,
      kid: thumbprint(recipient.pubJwk),
      z_hex: hex(z),
      other_info_hex: hex(otherInfo("A256GCM", c.host, c.state, 256)),
      cek_hex: hex(cek),
      ciphertext_b64url: ct,
      tag_b64url: tag,
      compact_jwe: jwe,
    },
    recipient,
    epk,
    iv,
    c,
  };
}

function replaceHeader(jwe, mutate) {
  const parts = jwe.split(".");
  const header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
  mutate(header);
  parts[0] = b64u(JSON.stringify(header));
  return parts.join(".");
}

function flipChar(s, i) {
  return s.slice(0, i) + (s[i] === "A" ? "B" : "A") + s.slice(i + 1);
}

export async function generate() {
  const out = {
    "jwe/kdf-rfc7518-appendix-c.json": await rfc7518AppendixC(),
    "jwe/kdf-rfc7520-5.5.json": await rfc7520Section55(),
  };
  const machine = await validHandoff("machine");
  out["jwe/handoff-v1-valid-machine.json"] = machine.file;
  out["jwe/handoff-v1-valid-control-plane.json"] = (await validHandoff("control-plane")).file;

  const { recipient, epk, iv, c } = machine;
  const good = machine.file.compact_jwe;
  const [h, , ivPart, ct, tag] = good.split(".");
  const resealed = (o) => seal({ recipient, epk, iv, host: o.host ?? c.host, state: o.state ?? c.state, payload: payloadFor(c, o.payload) });
  const offCurveY = b64u(Buffer.from(fromB64u(epk.pubJwk.y)).map((b, i) => (i === 31 ? b ^ 1 : b)));
  const compressed = b64u(Buffer.concat([Buffer.of(2 + (epk.raw[64] & 1)), epk.raw.subarray(1, 33)]));
  const invalid = {
    "tampered-ciphertext": ["jwe_decrypt_failed", [h, "", ivPart, flipChar(ct, 5), tag].join(".")],
    "tampered-header": ["jwe_decrypt_failed", replaceHeader(good, (x) => { x.zip = "none"; })],
    "wrong-kid": ["jwe_kid_mismatch", replaceHeader(good, (x) => { x.kid = thumbprint(p256FromLabel("handoff/other").pubJwk); })],
    "off-curve-epk": ["jwe_point_invalid", replaceHeader(good, (x) => { x.epk.y = offCurveY; })],
    "epk-x-31-bytes": ["jwe_point_invalid", replaceHeader(good, (x) => { x.epk.x = b64u(fromB64u(x.epk.x).subarray(1)); })],
    "compressed-point": ["jwe_point_invalid", replaceHeader(good, (x) => { x.epk.x = compressed; delete x.epk.y; })],
    "alg-rsa-oaep": ["jwe_unsupported", replaceHeader(good, (x) => { x.alg = "RSA-OAEP"; })],
    "enc-a128gcm": ["jwe_unsupported", replaceHeader(good, (x) => { x.enc = "A128GCM"; })],
    "apv-not-state": ["jwe_state_mismatch", await resealed({ state: b64u("some-other-handoff-state") })],
    "apu-not-host": ["jwe_host_mismatch", await resealed({ host: "evil.example.com" })],
    "plaintext-host-mismatch": ["jwe_host_mismatch", await resealed({ payload: { host: "other-ada.example.com" } })],
    "kind-mismatch": ["jwe_kind_mismatch", await resealed({ payload: { kind: "control_plane" } })],
    expired: ["jwe_expired", await resealed({ payload: { exp: NOW + 60 } })],
    "non-empty-part-2": ["jwe_malformed", [h, "AAAA", ivPart, ct, tag].join(".")],
    "six-parts": ["jwe_malformed", `${good}.AAAA`],
  };
  for (const [name, [code, jwe]] of Object.entries(invalid)) {
    out[`jwe/handoff-v1-invalid-${name}.json`] = {
      description: `Opening must fail with ${code}.`,
      recipient_jwk: recipient.jwk,
      recipient_pk: recipient.pk,
      expected_host: c.host,
      expected_state: c.state,
      expected_kind: c.kind,
      now: NOW,
      compact_jwe: jwe,
      expect_code: code,
    };
  }
  return out;
}
