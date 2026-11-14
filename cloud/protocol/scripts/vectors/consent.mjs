/**
 * Generates the D24 vectors (Design §8.1): `sig/device-fingerprint.json`,
 * `sig/handoff-device-signature.json`, `handoff/consent-cookie.json` and
 * `handoff/remembered-consent.json`.
 *
 * ECDSA is randomized, so `dsig` values are committed once: a committed signature that
 * still verifies over the regenerated canonical string is kept, and `--check` therefore
 * verifies rather than regenerates it. Everything else is deterministic (HMAC, HKDF).
 *
 * <module-headers:begin>
 * Uses:
 * scripts/vectors/consent.mjs
 * ├── scripts/vectors/keys.mjs
 * └── scripts/vectors/sig.mjs
 * External: node:crypto
 *
 * Used by:
 * scripts/vectors/consent.mjs
 * └── scripts/gen-vectors.mjs
 * <module-headers:end>
 */
import { createHmac, createPrivateKey, createPublicKey, hkdfSync, sign, verify } from "node:crypto";
import { b64u, fromB64u, hex, P256_N, p256FromLabel, sha256 } from "./keys.mjs";
import { fingerprint } from "./sig.mjs";

const NOW = 1731571200;
const HOST = "laptop-ada.example.com";
const DEVICE_TAG = "yaran-device-key-v1\n";

const canonical = (f) => `yaran-handoff-device-v1\n${f.host}\n${f.pk}\n${f.state}\n${f.dts}\n`;

function ecdsaSign(key, text, previous) {
  const pub = createPublicKey({ key: key.pubJwk, format: "jwk" });
  if (previous && previous.length === 86 && verify("sha256", Buffer.from(text), { key: pub, dsaEncoding: "ieee-p1363" }, fromB64u(previous))) {
    return previous;
  }
  const priv = createPrivateKey({ key: key.jwk, format: "jwk" });
  return b64u(sign("sha256", Buffer.from(text), { key: priv, dsaEncoding: "ieee-p1363" }));
}

function derFromRaw(raw) {
  const int = (b) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let v = b.subarray(i);
    if (v[0] & 0x80) v = Buffer.concat([Buffer.of(0), v]);
    return Buffer.concat([Buffer.of(0x02, v.length), v]);
  };
  const body = Buffer.concat([int(raw.subarray(0, 32)), int(raw.subarray(32))]);
  return Buffer.concat([Buffer.of(0x30, body.length), body]);
}

const nBytes = Buffer.from(P256_N.toString(16).padStart(64, "0"), "hex");

function deviceSignature(ctx) {
  const prev = ctx.previous("sig/handoff-device-signature.json");
  const dk = p256FromLabel("device-key");
  const other = p256FromLabel("device-key/other");
  const base = { host: HOST, pk: p256FromLabel("handoff/recipient/machine").pk, state: b64u("handoff-state-fixture-machine"), dts: String(NOW) };
  const text = canonical(base);
  const dsig = ecdsaSign(dk, text, prev?.dsig);
  const otherSig = ecdsaSign(other, text, prev?.cases?.find((c) => c.name === "other key's signature")?.fields.dsig);
  const raw = fromB64u(dsig);
  const fields = { ...base, dk: dk.pk, dsig };
  const offCurve = Buffer.from(dk.raw);
  offCurve[64] ^= 1;
  const compressed = Buffer.concat([Buffer.of(2 + (dk.raw[64] & 1)), dk.raw.subarray(1, 33)]);
  const c = (name, over, now, expect) => ({ name, fields: { ...fields, ...over }, now, expect });
  return {
    description: "Handoff device signature (Design §8.1): ES256 over the canonical string, raw r||s. dsig values are committed once (ECDSA is randomized). expect is {verified} after the field checks pass, or {code} from the field checks.",
    device_jwk: dk.jwk,
    dk: dk.pk,
    host: base.host,
    pk: base.pk,
    state: base.state,
    dts: base.dts,
    now: NOW,
    canonical_utf8: text,
    canonical_hex: hex(Buffer.from(text)),
    dsig,
    cases: [
      c("valid", {}, NOW, { verified: true }),
      c("wrong host", { host: "cp.example.com" }, NOW, { verified: false }),
      c("wrong pk", { pk: p256FromLabel("handoff/recipient/control-plane").pk }, NOW, { verified: false }),
      c("wrong state", { state: b64u("handoff-state-fixture-other") }, NOW, { verified: false }),
      c("dts plus one", { dts: String(NOW + 1) }, NOW, { verified: false }),
      c("dts minus one", { dts: String(NOW - 1) }, NOW, { verified: false }),
      c("other key's signature", { dsig: otherSig }, NOW, { verified: false }),
      c("DER signature", { dsig: b64u(derFromRaw(raw)) }, NOW, { code: "handoff_signature_malformed" }),
      c("85 characters", { dsig: dsig.slice(0, 85) }, NOW, { code: "handoff_signature_malformed" }),
      c("87 characters", { dsig: `${dsig}A` }, NOW, { code: "handoff_signature_malformed" }),
      c("r is zero", { dsig: b64u(Buffer.concat([Buffer.alloc(32), raw.subarray(32)])) }, NOW, { code: "handoff_signature_malformed" }),
      c("s is n", { dsig: b64u(Buffer.concat([raw.subarray(0, 32), nBytes])) }, NOW, { code: "handoff_signature_malformed" }),
      c("dsig missing", { dsig: null }, NOW, { code: "handoff_signature_malformed" }),
      c("dts with a leading zero", { dts: `0${NOW}` }, NOW, { code: "handoff_signature_malformed" }),
      c("compressed dk", { dk: b64u(compressed) }, NOW, { code: "handoff_device_key_invalid" }),
      c("off-curve dk", { dk: b64u(offCurve) }, NOW, { code: "handoff_device_key_invalid" }),
      c("dk missing", { dk: null }, NOW, { code: "handoff_device_key_invalid" }),
      c("server 300 s ahead accepted", {}, NOW + 300, { verified: true }),
      c("server 300 s behind accepted", {}, NOW - 300, { verified: true }),
      c("server 301 s ahead refused", {}, NOW + 301, { code: "handoff_timestamp_skewed", server_time: NOW + 301 }),
      c("server 301 s behind refused", {}, NOW - 301, { code: "handoff_timestamp_skewed", server_time: NOW - 301 }),
    ],
  };
}

const KEY = sha256("yaran-fixture/consent-key");
const KV = 3;

function mac(key, host, fp24, iat, kv) {
  const input = `yaran-handoff-consent-v1\n${host}\n${fp24}\n${iat}\n${kv}\n`;
  return { input, mac: b64u(createHmac("sha256", key).update(input).digest()) };
}

const cookie = (fp24, iat, kv = KV, host = HOST) => `v1.${kv}.${fp24}.${iat}.${mac(KEY, host, fp24, iat, kv).mac}`;
const setCookie = (value, path) => `__Secure-yaran-handoff-consent=${value}; Path=${path}; Max-Age=34560000; Secure; HttpOnly; SameSite=Lax`;

function consentCookie(fp24) {
  const { input, mac: m } = mac(KEY, HOST, fp24, NOW, KV);
  const value = cookie(fp24, NOW);
  const dataKey = sha256("yaran-fixture/DATA_KEY");
  const workerKey = Buffer.from(hkdfSync("sha256", dataKey, "yaran-cloud", "v1/handoff_consent", 32));
  const neg = (name, v, expect_reason, over = {}) => ({ name, value: v, host: HOST, now: NOW, current_kv: KV, expect_reason, ...over });
  const flipped = `${value.slice(0, value.lastIndexOf(".") + 1)}${m[0] === "A" ? "B" : "A"}${m.slice(1)}`;
  return {
    description: "Remembered-consent cookie (Design §8.1). verify cases: expect_reason null means the cookie verifies; a failing cookie is ignored, never raised.",
    key_hex: hex(KEY),
    kv: KV,
    host: HOST,
    fp24,
    iat: NOW,
    mac_in_utf8: input,
    mac_in_hex: hex(Buffer.from(input)),
    mac: m,
    value,
    set_cookie: { machine: setCookie(value, "/__yaran/handoff"), control_plane: setCookie(value, "/v1/handoff") },
    worker_key: { data_key_b64: dataKey.toString("base64"), data_key_hex: hex(dataKey), salt_utf8: "yaran-cloud", info_utf8: "v1/handoff_consent", key_hex: hex(workerKey) },
    verify_cases: [
      neg("valid", value, null),
      neg("iat at now + 300 accepted", cookie(fp24, NOW + 300), null),
      neg("iat at now - 34560000 accepted", cookie(fp24, NOW - 34560000), null),
      neg("tampered mac", flipped, "bad_mac"),
      neg("other host", value, "bad_mac", { host: "other-ada.example.com" }),
      neg("stale kv", cookie(fp24, NOW, KV - 1), "stale_kv"),
      neg("iat after now + 300", cookie(fp24, NOW + 301), "iat_future"),
      neg("iat before now - 34560000", cookie(fp24, NOW - 34560001), "iat_expired"),
      neg("four parts", value.split(".").slice(1).join("."), "malformed"),
      neg("six parts", `${value}.x`, "malformed"),
      neg("wrong version tag", value.replace(/^v1\./, "v2."), "malformed"),
      neg("fp24 with dashes", value.replace(fp24, fp24.match(/.{4}/g).join("-")), "malformed"),
      neg("fp24 lowercase", value.replace(fp24, fp24.toLowerCase()), "malformed"),
      neg("kv with a leading zero", value.replace(`v1.${KV}.`, `v1.0${KV}.`), "malformed"),
    ],
  };
}

function rememberedConsent(fp24, otherFp24) {
  const row = (name, side, over, expect) => {
    const r = { name, side, build: "release", cookie: cookie(fp24, NOW), verified: true, dts_fresh: true, device_revoked: false, ...over };
    return { ...r, expect, continue_sets_cookie: r.verified, cancel_sets_cookie: false };
  };
  return {
    description: "The §8.1 skip rule. expect is skip or consent_page; continue_sets_cookie is whether a Continue after this GET sets the cookie (only when verified).",
    key_hex: hex(KEY),
    current_kv: KV,
    host: HOST,
    now: NOW,
    dk_fp24: fp24,
    rows: [
      row("every rule holds (worker)", "worker", {}, "skip"),
      row("every rule holds (yaran)", "yaran", {}, "skip"),
      row("every rule holds on a dev build", "worker", { build: "dev" }, "skip"),
      row("no cookie", "worker", { cookie: null }, "consent_page"),
      row("no cookie (yaran)", "yaran", { cookie: null }, "consent_page"),
      row("cookie mac fails", "worker", { cookie: cookie(fp24, NOW, KV, "other-ada.example.com") }, "consent_page"),
      row("cookie kv is stale", "yaran", { cookie: cookie(fp24, NOW, KV - 1) }, "consent_page"),
      row("cookie iat in the future", "worker", { cookie: cookie(fp24, NOW + 301) }, "consent_page"),
      row("cookie malformed", "yaran", { cookie: "v1.garbage" }, "consent_page"),
      row("cookie for another device key", "worker", { cookie: cookie(otherFp24, NOW) }, "consent_page"),
      row("signature does not verify", "worker", { verified: false }, "consent_page"),
      row("signature does not verify (yaran)", "yaran", { verified: false }, "consent_page"),
      row("dts not fresh", "yaran", { dts_fresh: false }, "consent_page"),
      row("device revoked (worker rule 5)", "worker", { device_revoked: true }, "consent_page"),
      row("device revoked is ignored on yaran", "yaran", { device_revoked: true }, "skip"),
    ],
  };
}

export async function generate(ctx) {
  const dk = p256FromLabel("device-key");
  const other = p256FromLabel("device-key/other");
  const fp = fingerprint(DEVICE_TAG, dk.raw);
  const otherFp = fingerprint(DEVICE_TAG, other.raw);
  return {
    "sig/device-fingerprint.json": {
      description: "DeviceKeyFingerprint (Design §8.1): the §7.1 construction with its own tag over the 65-byte point; fp24 is the cookie form.",
      tag: DEVICE_TAG,
      cases: ["device-key", "device-key/other", "fingerprint/device-a"].map((label) => {
        const k = p256FromLabel(label);
        return { dk: k.pk, dk_hex: hex(k.raw), ...fingerprint(DEVICE_TAG, k.raw) };
      }),
    },
    "sig/handoff-device-signature.json": deviceSignature(ctx),
    "handoff/consent-cookie.json": consentCookie(fp.fp24),
    "handoff/remembered-consent.json": rememberedConsent(fp.fp24, otherFp.fp24),
  };
}
