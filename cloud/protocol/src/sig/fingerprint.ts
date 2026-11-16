/**
 * Key fingerprints a person compares by eye (Design §7.1, §8.1): the machine key shown
 * on the pairing confirm page and by the CLI, and the device key shown in consoles.
 *
 * digest = SHA-256(tag || raw key bytes); the first 15 bytes (120 bits) in RFC 4648
 * base32 give 24 characters, displayed as six groups of four joined by "-". The base32
 * alphabet has no 0/1/8/9 to confuse with letters.
 *
 * - Pure apart from a WebCrypto SHA-256.
 * - Rust twin: `yaran_core::cloud::protocol::fingerprint`.
 *
 * <module-headers:begin>
 * Uses:
 * src/sig/fingerprint.ts
 * └── src/b64url.ts
 * External: none
 *
 * Used by:
 * src/sig/fingerprint.ts
 * ├── src/index.ts
 * ├── src/sig/device.ts
 * └── test/fingerprint.test.ts
 * <module-headers:end>
 */
import { b64urlDecode, concatBytes, sha256, utf8 } from "../b64url.ts";

export const MACHINE_KEY_TAG = "yaran-machine-key-v1\n";
export const DEVICE_KEY_TAG = "yaran-device-key-v1\n";
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32 without padding. */
export function base32(bytes: Uint8Array): string {
  let out = "";
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32[(acc >> bits) & 31];
    }
  }
  if (bits > 0) out += BASE32[(acc << (5 - bits)) & 31];
  return out;
}

/** The 24-character undashed fingerprint (the consent cookie's `fp24`). */
export async function fingerprint24(tag: string, key: Uint8Array): Promise<string> {
  const digest = await sha256(concatBytes(utf8.encode(tag), key));
  return base32(digest.subarray(0, 15));
}

/** The 29-character display form of a 24-character fingerprint. */
export function displayFingerprint(fp24: string): string {
  return fp24.match(/.{4}/g)!.join("-");
}

/** MachineKeyFingerprint of a 32-byte Ed25519 public key (raw bytes or its base64url). */
export async function machineKeyFingerprint(publicKey: Uint8Array | string): Promise<string> {
  const raw = typeof publicKey === "string" ? b64urlDecode(publicKey) : publicKey;
  if (!raw || raw.length !== 32) throw new Error("an Ed25519 public key is 32 bytes");
  return displayFingerprint(await fingerprint24(MACHINE_KEY_TAG, raw));
}

/** Case-insensitive comparison of a typed fingerprint, dashes optional. */
export function fingerprintsMatch(typed: string, expected: string): boolean {
  const norm = (s: string) => s.toUpperCase().replace(/[-\s]/g, "");
  return norm(typed) === norm(expected);
}
