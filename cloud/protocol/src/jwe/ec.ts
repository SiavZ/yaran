/**
 * P-256 point handling for the handoff envelope and the device key: raw point <-> JWK,
 * an explicit on-curve check, and the RFC 7638 JWK thumbprint.
 *
 * The protocol carries points as `P256Point` (base64url of the 65-byte uncompressed SEC1
 * form). Import-time validation is undocumented on some platforms, so every point that
 * crosses a trust boundary is checked here against y^2 = x^3 - 3x + b (mod p) before use
 * (opener obligation 4, Design §8).
 *
 * - Pure apart from WebCrypto digests and imports.
 *
 * <module-headers:begin>
 * Uses:
 * src/jwe/ec.ts
 * └── src/b64url.ts
 * External: none
 *
 * Used by:
 * src/jwe/ec.ts
 * ├── src/index.ts
 * ├── src/jwe/handoff.ts
 * ├── src/sig/device.ts
 * └── test/jwe.test.ts
 * <module-headers:end>
 */
import { b64urlDecode, b64urlEncode, concatBytes, sha256, utf8 } from "../b64url.ts";

/** P-256 field prime, curve constant b and group order n (SEC 2 §2.4.2). */
export const P256_P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
export const P256_B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;
export const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

export interface P256Jwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
}

/** Big-endian bytes to bigint. */
export function bytesToBigInt(bytes: Uint8Array): bigint {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
}

function mod(a: bigint, m: bigint): bigint {
  const r = a % m;
  return r < 0n ? r + m : r;
}

/** True when 0 <= x, y < p and (x, y) satisfies the P-256 curve equation. */
export function isOnP256(x: Uint8Array, y: Uint8Array): boolean {
  if (x.length !== 32 || y.length !== 32) return false;
  const X = bytesToBigInt(x);
  const Y = bytesToBigInt(y);
  if (X >= P256_P || Y >= P256_P) return false;
  return mod(Y * Y, P256_P) === mod(X * X * X - 3n * X + P256_B, P256_P);
}

/**
 * Decodes a `P256Point` string: strict base64url, 65 bytes, 0x04 prefix, on the curve.
 * Returns null otherwise.
 */
export function decodeP256Point(text: string): Uint8Array | null {
  const raw = b64urlDecode(text);
  if (!raw || raw.length !== 65 || raw[0] !== 0x04) return null;
  return isOnP256(raw.subarray(1, 33), raw.subarray(33)) ? raw : null;
}

/** The JWK form of a validated 65-byte raw point. */
export function pointToJwk(raw: Uint8Array): P256Jwk {
  return { kty: "EC", crv: "P-256", x: b64urlEncode(raw.subarray(1, 33)), y: b64urlEncode(raw.subarray(33)) };
}

/** The raw point of a JWK's x and y, or null when either is not exactly 32 bytes. */
export function jwkToPoint(jwk: { x?: unknown; y?: unknown }): Uint8Array | null {
  if (typeof jwk.x !== "string" || typeof jwk.y !== "string") return null;
  const x = b64urlDecode(jwk.x);
  const y = b64urlDecode(jwk.y);
  if (!x || !y || x.length !== 32 || y.length !== 32) return null;
  return concatBytes(Uint8Array.of(4), x, y);
}

/** RFC 7638 thumbprint: SHA-256 over {"crv","kty","x","y"} in that order, base64url. */
export async function jwkThumbprint(jwk: P256Jwk): Promise<string> {
  const canonical = `{"crv":"P-256","kty":"EC","x":"${jwk.x}","y":"${jwk.y}"}`;
  return b64urlEncode(await sha256(utf8.encode(canonical)));
}

/** Imports a validated raw point as a WebCrypto public key. */
export function importP256Public(raw: Uint8Array, use: "ECDH" | "ECDSA"): Promise<CryptoKey> {
  const usages: KeyUsage[] = use === "ECDSA" ? ["verify"] : [];
  return crypto.subtle.importKey("raw", raw as BufferSource, { name: use, namedCurve: "P-256" }, true, usages);
}
