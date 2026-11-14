/**
 * The setup code gate: checks the code, locks out brute force, and issues the setup cookie.
 *
 * Before Access exists the setup code is the only thing guarding the wizard, so:
 * the comparison is constant-time over HMACs under a fresh random key; every wrong code
 * counts in D1 and the twentieth locks the wizard until `SETUP_CODE` changes (detected by
 * the code's hash stored at lockout); and success issues `__Host-yaran-setup`, an HMAC over
 * its expiry under a key derived from `SETUP_CODE` through HKDF, valid for 30 minutes.
 *
 * - Also explains a missing or weak `SETUP_CODE`, or a missing or malformed `DATA_KEY`.
 * - Rate limiting per IP (5 a minute) is 04's limiter, asked through the port.
 */
import { b64urlDecode, b64urlEncode, timingSafeEqual } from "@yaran/protocol";
import type { D1Like } from "../admin/ports.ts";
import { readKey, writeKeys } from "../admin/settings-store.ts";

export const SETUP_CODE_MIN = 24;
export const LOCKOUT_AFTER = 20;
export const COOKIE_NAME = "__Host-yaran-setup";
export const COOKIE_TTL_S = 30 * 60;

/** Indirection so a test can prove the constant-time comparison is the one used. */
export const compare = { equal: timingSafeEqual };

const enc = new TextEncoder();

export interface SetupSecrets {
  SETUP_CODE?: string | undefined;
  DATA_KEY?: string | undefined;
}

export type SecretProblem = "setup_code_missing" | "setup_code_short" | "data_key_missing" | "data_key_malformed";

/** What stops the wizard from starting; `dataKeyValid` is 04's DATA_KEY format check. */
export function secretProblems(env: SetupSecrets, dataKeyValid: (key: string) => boolean): SecretProblem[] {
  const out: SecretProblem[] = [];
  if (!env.SETUP_CODE) out.push("setup_code_missing");
  else if (env.SETUP_CODE.length < SETUP_CODE_MIN) out.push("setup_code_short");
  if (!env.DATA_KEY) out.push("data_key_missing");
  else if (!dataKeyValid(env.DATA_KEY)) out.push("data_key_malformed");
  return out;
}

async function hmac(key: CryptoKey, data: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

export async function sha256Hex(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text)));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time equality of two strings: HMAC both under a random key, compare the MACs. */
export async function codesMatch(input: string, expected: string): Promise<boolean> {
  const key = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return compare.equal(await hmac(key, input), await hmac(key, expected));
}

interface FailureState {
  count: number;
  locked_code_hash?: string;
}

const FAILURES_KEY = "setup_code_failures";

export type CodeVerdict = "ok" | "setup_code_invalid" | "setup_locked";

/** Checks a submitted code against `SETUP_CODE`, counting failures and applying the lockout. */
export async function checkSetupCode(db: D1Like, input: string, setupCode: string, now: Date): Promise<CodeVerdict> {
  let state = (await readKey<FailureState>(db, FAILURES_KEY)) ?? { count: 0 };
  if (state.locked_code_hash !== undefined) {
    if (state.locked_code_hash === (await sha256Hex(setupCode))) return "setup_locked";
    state = { count: 0 }; // SETUP_CODE changed since the lockout: start over.
    await writeKeys(db, { [FAILURES_KEY]: state }, "setup", now);
  }
  if (await codesMatch(input, setupCode)) return "ok";
  const count = state.count + 1;
  const next: FailureState = count >= LOCKOUT_AFTER ? { count, locked_code_hash: await sha256Hex(setupCode) } : { count };
  await writeKeys(db, { [FAILURES_KEY]: next }, "setup", now);
  return next.locked_code_hash ? "setup_locked" : "setup_code_invalid";
}

export async function isLocked(db: D1Like, setupCode: string): Promise<boolean> {
  const state = await readKey<FailureState>(db, FAILURES_KEY);
  return state?.locked_code_hash !== undefined && state.locked_code_hash === (await sha256Hex(setupCode));
}

async function cookieKey(setupCode: string): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey("raw", enc.encode(setupCode), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode("yaran-cloud"), info: enc.encode("v1/setup_cookie") },
    ikm,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"],
  );
}

/** The `Set-Cookie` value for a fresh setup session. */
export async function issueSetupCookie(setupCode: string, now: Date): Promise<string> {
  const exp = Math.floor(now.getTime() / 1000) + COOKIE_TTL_S;
  const mac = b64urlEncode(await hmac(await cookieKey(setupCode), String(exp)));
  return `${COOKIE_NAME}=${exp}.${mac}; Max-Age=${COOKIE_TTL_S}; Path=/; HttpOnly; Secure; SameSite=Strict`;
}

export function clearSetupCookie(): string {
  return `${COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict`;
}

/** True when the request carries an unexpired setup cookie signed under the current code. */
export async function hasSetupSession(request: Request, setupCode: string, now: Date): Promise<boolean> {
  const cookie = request.headers.get("Cookie") ?? "";
  const value = cookie
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${COOKIE_NAME}=`))
    ?.slice(COOKIE_NAME.length + 1);
  const [expText, macText] = (value ?? "").split(".");
  const exp = Number(expText);
  const mac = macText ? b64urlDecode(macText) : null;
  if (!mac || !Number.isInteger(exp) || exp <= now.getTime() / 1000) return false;
  return compare.equal(mac, await hmac(await cookieKey(setupCode), String(exp)));
}
