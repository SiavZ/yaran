/**
 * The handoff device signature (Design §8.1, D24): the canonical string the app's
 * hardware-held P-256 device key signs, the form and freshness checks a handoff server
 * runs on `dk`/`dts`/`dsig`, the ES256 verification, and the device key fingerprint.
 *
 * A well-formed signature that does not verify is not an error: it yields
 * `verified = false` and the consent page. Only malformed input maps to a code.
 *
 * - Trust boundary: `dk`, `dts`, `dsig`, `pk` and `state` come from the query string;
 *   `host` must be the server's own served hostname, never a query value.
 * - Rust twin: `yaran_core::cloud::protocol::handoff_consent`.
 *
 * <module-headers:begin>
 * Uses:
 * src/sig/device.ts
 * ├── src/b64url.ts
 * ├── src/jwe/ec.ts
 * └── src/sig/fingerprint.ts
 * External: none
 *
 * Used by:
 * src/sig/device.ts
 * ├── src/index.ts
 * ├── test/device.test.ts
 * └── test/fingerprint.test.ts
 * <module-headers:end>
 */
import { b64urlDecode, utf8 } from "../b64url.ts";
import { bytesToBigInt, decodeP256Point, importP256Public, P256_N } from "../jwe/ec.ts";
import { DEVICE_KEY_TAG, displayFingerprint, fingerprint24 } from "./fingerprint.ts";

export const HANDOFF_DEVICE_TAG = "yaran-handoff-device-v1";
export const HANDOFF_DTS_SKEW_S = 300;
const DTS_RE = /^(?:0|[1-9][0-9]{0,11})$/;
const DSIG_RE = /^[A-Za-z0-9_-]{86}$/;

export interface DeviceSigned {
  /** The server's own served hostname, lowercase, no port, no trailing dot. */
  host: string;
  pk: string;
  state: string;
  dts: string;
}

/** The five LF-terminated lines the device key signs. */
export function handoffDeviceCanonical(s: DeviceSigned): string {
  return `${HANDOFF_DEVICE_TAG}\n${s.host}\n${s.pk}\n${s.state}\n${s.dts}\n`;
}

export type DeviceFieldError = "handoff_device_key_invalid" | "handoff_signature_malformed" | "handoff_timestamp_skewed";

/** r and s of a raw 64-byte signature when both lie in 1..n-1, else null. */
export function parseRawSignature(dsig: string): Uint8Array | null {
  if (!DSIG_RE.test(dsig)) return null;
  const raw = b64urlDecode(dsig);
  if (!raw || raw.length !== 64) return null;
  const r = bytesToBigInt(raw.subarray(0, 32));
  const s = bytesToBigInt(raw.subarray(32));
  return r > 0n && r < P256_N && s > 0n && s < P256_N ? raw : null;
}

/**
 * Form and freshness checks, in §8.1 order: dk, then dts and dsig form, then skew.
 * Missing fields fail as malformed ones. Returns null when all pass.
 */
export function checkHandoffDeviceFields(
  f: { dk?: string | null; dts?: string | null; dsig?: string | null },
  now: number,
): { code: DeviceFieldError; serverTime?: number } | null {
  if (!f.dk || !decodeP256Point(f.dk)) return { code: "handoff_device_key_invalid" };
  if (!f.dts || !DTS_RE.test(f.dts) || !f.dsig || !parseRawSignature(f.dsig)) return { code: "handoff_signature_malformed" };
  if (Math.abs(now - Number(f.dts)) > HANDOFF_DTS_SKEW_S) return { code: "handoff_timestamp_skewed", serverTime: now };
  return null;
}

/** Verifies dsig over the canonical string with dk. Call only after the field checks pass. */
export async function verifyHandoffDeviceSig(s: DeviceSigned & { dk: string; dsig: string }): Promise<boolean> {
  const point = decodeP256Point(s.dk);
  const sig = parseRawSignature(s.dsig);
  if (!point || !sig) return false;
  const key = await importP256Public(point, "ECDSA");
  return crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    sig as BufferSource,
    utf8.encode(handoffDeviceCanonical(s)) as BufferSource,
  );
}

/** The 24-character device fingerprint (the consent cookie's fp24) of a P256Point string. */
export async function deviceKeyFp24(dk: string): Promise<string> {
  const point = decodeP256Point(dk);
  if (!point) throw new Error("dk is not a valid P-256 point");
  return fingerprint24(DEVICE_KEY_TAG, point);
}

/** DeviceKeyFingerprint (29-character display form) of a P256Point string. */
export async function deviceKeyFingerprint(dk: string): Promise<string> {
  return displayFingerprint(await deviceKeyFp24(dk));
}
