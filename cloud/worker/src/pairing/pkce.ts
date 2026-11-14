/**
 * PKCE S256 (RFC 7636) and the one-time secrets of the pairing flow: the 43-character
 * pair code, csrf tokens and their SHA-256 hashes.
 *
 * - Only hashes are ever stored; comparisons are constant time.
 *
 * <module-headers:begin>
 * Uses:
 * src/pairing/pkce.ts
 * └── @yaran/protocol:src/index.ts
 * External: none
 *
 * Used by:
 * src/pairing/pkce.ts
 * ├── src/machine-api/claim.ts
 * ├── src/pairing/authorize-route.ts
 * ├── src/pairing/pair-requests.ts
 * ├── src/sessions/handoff-csrf.ts
 * ├── test/pairing/pair-requests.test.ts
 * └── test/pairing/pkce.test.ts
 * <module-headers:end>
 */
import { b64urlEncode, sha256, timingSafeEqual, utf8 } from "@yaran/protocol";

/** RFC 7636 §4.1: 43-128 unreserved characters. */
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;

/** SHA-256 of a string's UTF-8 bytes. */
export function sha256Text(text: string): Promise<Uint8Array> {
  return sha256(utf8.encode(text));
}

/** True when base64url(SHA-256(verifier)) equals the stored challenge. */
export async function verifyS256(verifier: string, challenge: string): Promise<boolean> {
  if (!VERIFIER_RE.test(verifier)) return false;
  const computed = b64urlEncode(await sha256Text(verifier));
  return timingSafeEqual(utf8.encode(computed), utf8.encode(challenge));
}

/** `n` random bytes as base64url; 32 bytes is the 43-character pair code. */
export function randomToken(n = 32): string {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(n)));
}
