/**
 * Strict base64url, hex and UTF-8 byte helpers shared by every codec in this package.
 *
 * The protocol signs and compares encoded strings byte for byte (the handoff device
 * signature signs `pk` as sent, the fingerprint and thumbprint hash raw bytes), so the
 * decoder is strict: no padding, only the base64url alphabet, and no non-zero trailing
 * bits. A lenient decoder would accept two spellings of one key.
 *
 * - Pure functions, no I/O; usable in Node, Workers and the WebView shell.
 *
 * <module-headers:begin>
 * Uses: none
 * External: none
 *
 * Used by:
 * src/b64url.ts
 * ├── src/consent.ts
 * ├── src/index.ts
 * ├── src/jwe/ec.ts
 * ├── src/jwe/handoff.ts
 * ├── src/jwe/kdf.ts
 * ├── src/push/payload.ts
 * ├── src/push/topic.ts
 * ├── src/sig/canonical.ts
 * ├── src/sig/device.ts
 * ├── src/sig/fingerprint.ts
 * ├── src/sig/sign.ts
 * ├── src/sig/verify.ts
 * ├── test/consent.test.ts
 * ├── test/device.test.ts
 * ├── test/jwe.test.ts
 * └── test/sig.test.ts
 * <module-headers:end>
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const LOOKUP = new Map<string, number>([...ALPHABET].map((c, i) => [c, i]));

export const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

/** Encodes bytes as base64url without padding. */
export function b64urlEncode(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]! + ALPHABET[(n >> 6) & 63]! + ALPHABET[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]!;
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]! + ALPHABET[(n >> 6) & 63]!;
  }
  return out;
}

/**
 * Decodes strict base64url (no padding, canonical trailing bits). Returns null for any
 * other input, so callers map a bad encoding to their own registry code.
 */
export function b64urlDecode(text: string): Uint8Array | null {
  if (text.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (const c of text) {
    const v = LOOKUP.get(c);
    if (v === undefined) return null;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  if (bits > 0 && (acc & ((1 << bits) - 1)) !== 0) return null;
  return out;
}

/** Lowercase hex. */
export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Parses even-length hex (either case); throws on anything else (fixtures only feed it). */
export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) throw new Error(`bad hex: ${hex.slice(0, 16)}`);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Decodes UTF-8, returning null for invalid sequences. */
export function utf8Decode(bytes: Uint8Array): string | null {
  try {
    return utf8Decoder.decode(bytes);
  } catch {
    return null;
  }
}

/** Concatenates byte arrays. */
export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Constant-time equality for equal-length secrets; unequal lengths return false. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** SHA-256 via WebCrypto. */
export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
}
