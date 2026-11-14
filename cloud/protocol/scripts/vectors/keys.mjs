/**
 * Deterministic key material for the fixture generators: every key in a vector is
 * derived from a fixed label, so regenerating never changes a committed byte.
 *
 * - P-256: d = SHA-256(label) (re-hashed in the negligible case it is >= n), public
 *   point from node:crypto ECDH.
 * - Ed25519: seed = SHA-256(label); PKCS#8 v1 (RFC 8410) and the v2 form ring writes.
 * - Also a node:crypto Concat KDF, independent of src/jwe/kdf.ts.
 *
 * <module-headers:begin>
 * Uses:
 * scripts/vectors/keys.mjs
 * External: node:crypto
 *
 * Used by:
 * scripts/vectors/keys.mjs
 * ├── scripts/vectors/consent.mjs
 * ├── scripts/vectors/jwe.mjs
 * ├── scripts/vectors/sig.mjs
 * └── scripts/vectors/webpush.mjs
 * <module-headers:end>
 */
import { createECDH, createHash, createPrivateKey, createPublicKey } from "node:crypto";

export const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

export const sha256 = (data) => createHash("sha256").update(data).digest();
export const b64u = (buf) => Buffer.from(buf).toString("base64url");
export const fromB64u = (s) => Buffer.from(s, "base64url");
export const hex = (buf) => Buffer.from(buf).toString("hex");

/** A P-256 key from a label: { d, raw (65-byte point), pk (P256Point), jwk (with d), pubJwk }. */
export function p256FromLabel(label) {
  let d = sha256(`yaran-fixture/${label}`);
  while (BigInt(`0x${hex(d)}`) >= P256_N || BigInt(`0x${hex(d)}`) === 0n) d = sha256(d);
  return p256FromPrivate(d);
}

export function p256FromPrivate(d) {
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(d);
  const raw = ecdh.getPublicKey(null, "uncompressed");
  const pubJwk = { kty: "EC", crv: "P-256", x: b64u(raw.subarray(1, 33)), y: b64u(raw.subarray(33)) };
  return { d, raw, pk: b64u(raw), pubJwk, jwk: { ...pubJwk, d: b64u(d) }, ecdh };
}

/** The raw 32-byte ECDH x-coordinate between a private key and a raw public point. */
export function ecdhZ(privateD, peerRaw) {
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(privateD);
  return ecdh.computeSecret(peerRaw);
}

const ED25519_PKCS8_V1_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/** An Ed25519 key from a label: { seed, pub (32 bytes), pkcs8V1, pkcs8V2, privateKey (KeyObject) }. */
export function ed25519FromLabel(label) {
  const seed = sha256(`yaran-fixture/${label}`);
  const pkcs8V1 = Buffer.concat([ED25519_PKCS8_V1_PREFIX, seed]);
  const privateKey = createPrivateKey({ key: pkcs8V1, format: "der", type: "pkcs8" });
  const pub = fromB64u(createPublicKey(privateKey).export({ format: "jwk" }).x);
  // OneAsymmetricKey v2 with the public key in [1], the form ring's generate_pkcs8 writes.
  const pkcs8V2 = Buffer.concat([Buffer.from("3053020101300506032b657004220420", "hex"), seed, Buffer.from("a123032100", "hex"), pub]);
  return { seed, pub, pkcs8V1, pkcs8V2, privateKey };
}

const be32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};

/** RFC 7518 §4.6.2 OtherInfo for direct ECDH-ES. */
export function otherInfo(enc, apu, apv, keyBits) {
  const lp = (b) => Buffer.concat([be32(b.length), b]);
  return Buffer.concat([lp(Buffer.from(enc)), lp(Buffer.from(apu)), lp(Buffer.from(apv)), be32(keyBits)]);
}

/** Concat KDF over SHA-256 (one or two rounds). */
export function concatKdf(z, enc, apu, apv, keyBits) {
  const info = otherInfo(enc, apu, apv, keyBits);
  const blocks = [];
  for (let c = 1; c <= Math.ceil(keyBits / 256); c++) blocks.push(sha256(Buffer.concat([be32(c), z, info])));
  return Buffer.concat(blocks).subarray(0, keyBits / 8);
}

export function assertEq(actual, expected, what) {
  if (actual !== expected) throw new Error(`${what}: generated ${actual}, expected ${expected}`);
}
