/**
 * Remembered handoff consent (Design §8.1, D24): the MACed, host-only consent cookie and
 * the skip rule that decides whether a handoff GET may skip the consent page.
 *
 * The page is skipped only when the cookie verifies under the current key version, its
 * fingerprint equals the request's device key, the device signature verified, `dts` is
 * fresh, and (Worker only) no revoked device carries that key. A failing cookie is
 * ignored, never an error, and never cleared. Only an explicit Continue whose GET
 * verified sets the cookie.
 *
 * - Trust boundary: the cookie value is attacker-controlled; the MAC is compared in
 *   constant time and `iat` is range-checked because Max-Age is only the browser's promise.
 * - Rust twin: `yaran_core::cloud::protocol::handoff_consent`.
 *
 * <module-headers:begin>
 * Uses:
 * src/consent.ts
 * └── src/b64url.ts
 * External: (none)
 *
 * Used by:
 * src/consent.ts
 * ├── src/index.ts
 * └── test/consent.test.ts
 * <module-headers:end>
 */
import { b64urlDecode, b64urlEncode, timingSafeEqual, utf8 } from "./b64url.ts";

export const CONSENT_COOKIE_NAME = "__Secure-yaran-handoff-consent";
/** 400 days, the browser cap. */
export const CONSENT_MAX_AGE_S = 34_560_000;
export const CONSENT_IAT_FUTURE_S = 300;
export const CONSENT_PATHS = { machine: "/__yaran/handoff", control_plane: "/v1/handoff" } as const;
export const CONSENT_MAC_TAG = "yaran-handoff-consent-v1";
/** Worker key derivation: HKDF-SHA256(DATA_KEY, salt, info), Phase 04's per-purpose scheme. */
export const WORKER_CONSENT_SALT = "yaran-cloud";
export const WORKER_CONSENT_INFO = "v1/handoff_consent";

const KV_RE = /^[1-9][0-9]{0,8}$/;
const FP24_RE = /^[A-Z2-7]{24}$/;
const IAT_RE = /^(?:0|[1-9][0-9]{0,11})$/;
const MAC_RE = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

export interface ConsentCookie {
  kv: number;
  fp24: string;
  iat: number;
  mac: string;
}

/** The ASCII bytes the MAC covers; host is bound here rather than carried in the value. */
export function consentMacInput(host: string, fp24: string, iat: number, kv: number): string {
  return `${CONSENT_MAC_TAG}\n${host}\n${fp24}\n${iat}\n${kv}\n`;
}

/** base64url(HMAC-SHA256(key, mac_in)), 43 characters. */
export async function consentMac(key: Uint8Array, host: string, fp24: string, iat: number, kv: number): Promise<string> {
  const k = await crypto.subtle.importKey("raw", key as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", k, utf8.encode(consentMacInput(host, fp24, iat, kv)) as BufferSource);
  return b64urlEncode(new Uint8Array(mac));
}

/** The cookie value `v1.<kv>.<fp24>.<iat>.<mac>`. */
export async function buildConsentCookie(o: { key: Uint8Array; kv: number; host: string; fp24: string; iat: number }): Promise<string> {
  return `v1.${o.kv}.${o.fp24}.${o.iat}.${await consentMac(o.key, o.host, o.fp24, o.iat, o.kv)}`;
}

/** The Set-Cookie header value for the given handoff path. */
export function consentSetCookie(value: string, path: string): string {
  return `${CONSENT_COOKIE_NAME}=${value}; Path=${path}; Max-Age=${CONSENT_MAX_AGE_S}; Secure; HttpOnly; SameSite=Lax`;
}

/** Parses the value's five parts; null for anything malformed. */
export function parseConsentCookie(value: string): ConsentCookie | null {
  const parts = value.split(".");
  if (parts.length !== 5) return null;
  const [v, kv, fp24, iat, mac] = parts as [string, string, string, string, string];
  if (v !== "v1" || !KV_RE.test(kv) || !FP24_RE.test(fp24) || !IAT_RE.test(iat) || !MAC_RE.test(mac)) return null;
  return { kv: Number(kv), fp24, iat: Number(iat), mac };
}

export type CookieVerdict =
  | { ok: true; fp24: string }
  | { ok: false; reason: "malformed" | "stale_kv" | "bad_mac" | "iat_future" | "iat_expired" };

/** Checks a cookie value against the server's current key; only that version verifies. */
export async function verifyConsentCookie(o: {
  value: string;
  host: string;
  key: Uint8Array;
  currentKv: number;
  now: number;
}): Promise<CookieVerdict> {
  const c = parseConsentCookie(o.value);
  if (!c) return { ok: false, reason: "malformed" };
  if (c.kv !== o.currentKv) return { ok: false, reason: "stale_kv" };
  const expected = b64urlDecode(await consentMac(o.key, o.host, c.fp24, c.iat, c.kv))!;
  if (!timingSafeEqual(b64urlDecode(c.mac)!, expected)) return { ok: false, reason: "bad_mac" };
  if (c.iat > o.now + CONSENT_IAT_FUTURE_S) return { ok: false, reason: "iat_future" };
  if (c.iat < o.now - CONSENT_MAX_AGE_S) return { ok: false, reason: "iat_expired" };
  return { ok: true, fp24: c.fp24 };
}

export interface RememberedInput {
  side: "worker" | "yaran";
  /** The consent cookie value, or null when the request carried none. */
  cookie: string | null;
  host: string;
  /** fp24 of the request's dk. */
  dkFp24: string;
  /** The device signature verdict. */
  verified: boolean;
  dtsFresh: boolean;
  /** Worker only: a revoked device row carries this device key fingerprint. */
  deviceRevoked: boolean;
  key: Uint8Array;
  currentKv: number;
  now: number;
}

/** The skip rule. Every rule must hold; anything else shows the consent page. */
export async function decideRemembered(i: RememberedInput): Promise<"skip" | "consent_page"> {
  if (i.cookie === null || !i.verified || !i.dtsFresh) return "consent_page";
  if (i.side === "worker" && i.deviceRevoked) return "consent_page";
  const verdict = await verifyConsentCookie({ value: i.cookie, host: i.host, key: i.key, currentKv: i.currentKv, now: i.now });
  return verdict.ok && verdict.fp24 === i.dkFp24 ? "skip" : "consent_page";
}

/** Whether the consent POST's 303 carries Set-Cookie. */
export function consentSetsCookie(decision: "continue" | "cancel", verified: boolean): boolean {
  return decision === "continue" && verified;
}

/** The Worker's consent MAC key from the decoded DATA_KEY bytes. */
export async function workerConsentKey(dataKey: Uint8Array): Promise<Uint8Array> {
  const ikm = await crypto.subtle.importKey("raw", dataKey as BufferSource, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: utf8.encode(WORKER_CONSENT_SALT) as BufferSource, info: utf8.encode(WORKER_CONSENT_INFO) as BufferSource },
    ikm,
    256,
  );
  return new Uint8Array(bits);
}
