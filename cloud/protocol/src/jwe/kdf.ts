/**
 * The JWE Concat KDF (RFC 7518 §4.6.2, NIST SP 800-56A single-step KDF with SHA-256).
 *
 * The handoff seal itself goes through jose; this module exists to pin the RFC 7518
 * Appendix C and RFC 7520 §5.5 vectors, to prove jose's KDF against an independent
 * implementation, and to let `openHandoff` derive the CEK with plain WebCrypto (Swift and
 * Kotlin openers reimplement exactly this, never CryptoKit's X9.63 helper).
 *
 * - Pure apart from WebCrypto SHA-256.
 *
 * <module-headers:begin>
 * Uses:
 * src/jwe/kdf.ts
 * └── src/b64url.ts
 * External: (none)
 *
 * Used by:
 * src/jwe/kdf.ts
 * ├── src/index.ts
 * ├── src/jwe/handoff.ts
 * └── test/jwe.test.ts
 * <module-headers:end>
 */
import { concatBytes, sha256, utf8 } from "../b64url.ts";

function be32(n: number): Uint8Array {
  return Uint8Array.of((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
}

function lengthPrefixed(bytes: Uint8Array): Uint8Array {
  return concatBytes(be32(bytes.length), bytes);
}

/**
 * OtherInfo = len32(alg) || alg || len32(apu) || apu || len32(apv) || apv || be32(keydatalen).
 * For direct ECDH-ES the AlgorithmID is the `enc` value.
 */
export function concatKdfOtherInfo(algorithmId: string, apu: Uint8Array, apv: Uint8Array, keyBits: number): Uint8Array {
  return concatBytes(lengthPrefixed(utf8.encode(algorithmId)), lengthPrefixed(apu), lengthPrefixed(apv), be32(keyBits));
}

/** Derives keyBits of key material from the ECDH secret Z. */
export async function concatKdf(
  z: Uint8Array,
  algorithmId: string,
  apu: Uint8Array,
  apv: Uint8Array,
  keyBits: number,
): Promise<Uint8Array> {
  const otherInfo = concatKdfOtherInfo(algorithmId, apu, apv, keyBits);
  const rounds = Math.ceil(keyBits / 256);
  const blocks: Uint8Array[] = [];
  for (let counter = 1; counter <= rounds; counter++) {
    blocks.push(await sha256(concatBytes(be32(counter), z, otherInfo)));
  }
  return concatBytes(...blocks).subarray(0, keyBits / 8);
}
