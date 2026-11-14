/**
 * Validators for W2 `GET /v1/pair/authorize` (02 `PairAuthorizeQuery`): the loopback
 * callback, state, PKCE challenge, machine key, machine name, origin port and version.
 *
 * Each rule is one pure function returning its 02 refusal code or null, so the table
 * tests pin them one by one. `parseAuthorizeQuery` runs them in order and says whether a
 * refusal may be redirected: only once the callback and the state are valid.
 *
 * - The callback is exactly `http://127.0.0.1:<port>/callback`, port 1024-65535
 *   (RFC 8252 §7.3): no `localhost`, IPv6, other paths, queries or fragments.
 * - The machine key must import as Ed25519 through WebCrypto, not merely decode.
 *
 * <module-headers:begin>
 * Uses:
 * src/pairing/authorize-params.ts
 * └── @yaran/protocol:src/index.ts
 * External: none
 *
 * Used by:
 * src/pairing/authorize-params.ts
 * ├── src/pairing/authorize-route.ts
 * └── test/pairing/authorize-params.test.ts
 * <module-headers:end>
 */
import { b64urlDecode, PROTOCOL_MAX, PROTOCOL_MIN, validate, type ErrorCode, type PairAuthorizeQuery } from "@yaran/protocol";

export const DEFAULT_ORIGIN_PORT = 3890;
const CALLBACK_RE = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{3,4})\/callback$/;
const STATE_RE = /^[A-Za-z0-9_-]{22,128}$/;
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
const MACHINE_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/;
const DECIMAL_RE = /^[1-9][0-9]{0,4}$/;
const VERSION_RE = /^[\x21-\x7e]{1,40}$/;

/** The callback's port, or null when the callback is refused. */
export function callbackPort(callback: string | null): number | null {
  const m = callback === null ? null : CALLBACK_RE.exec(callback);
  if (!m) return null;
  const port = Number(m[1]);
  return port >= 1024 && port <= 65535 ? port : null;
}

export function checkState(state: string | null): boolean {
  return state !== null && STATE_RE.test(state);
}

export function checkVersion(v: string | null): { min: number; max: number } | null {
  const n = v !== null && DECIMAL_RE.test(v) ? Number(v) : NaN;
  return n >= PROTOCOL_MIN && n <= PROTOCOL_MAX ? null : { min: PROTOCOL_MIN, max: PROTOCOL_MAX };
}

export function checkChallenge(challenge: string | null, method: string | null): ErrorCode | null {
  return challenge !== null && CHALLENGE_RE.test(challenge) && method === "S256" ? null : "pair_request_invalid";
}

/** The 32 raw key bytes when the value is base64url of exactly 32 bytes that imports as Ed25519. */
export async function checkMachinePubkey(value: string | null): Promise<Uint8Array | null> {
  const raw = value === null || value.length !== 43 ? null : b64urlDecode(value);
  if (!raw || raw.length !== 32) return null;
  try {
    await crypto.subtle.importKey("raw", raw as BufferSource, { name: "Ed25519" }, false, ["verify"]);
    return raw;
  } catch {
    return null;
  }
}

export function checkMachineName(name: string | null): boolean {
  return name !== null && MACHINE_NAME_RE.test(name);
}

/** The origin port (default 3890), or null when present and out of 1-65535. */
export function checkOriginPort(value: string | null): number | null {
  if (value === null) return DEFAULT_ORIGIN_PORT;
  const n = DECIMAL_RE.test(value) ? Number(value) : NaN;
  return n >= 1 && n <= 65535 ? n : null;
}

export function checkYaranVersion(v: string | null): boolean {
  return v !== null && VERSION_RE.test(v);
}

export interface AuthorizeQuery {
  v: number;
  state: string;
  codeChallenge: string;
  machinePubkey: Uint8Array;
  machinePubkeyB64: string;
  machineName: string;
  callbackPort: number;
  originPort: number;
  yaranVersion: string;
}

export type AuthorizeParse =
  | { ok: true; q: AuthorizeQuery }
  /** `redirect` is set once the callback and state are valid; otherwise answer a 400 page. */
  | { ok: false; code: ErrorCode; redirect: { port: number; state: string } | null; details?: Record<string, unknown> };

/** Runs every rule in the documented order. */
export async function parseAuthorizeQuery(params: URLSearchParams): Promise<AuthorizeParse> {
  const get = (k: string) => params.get(k);
  const port = callbackPort(get("callback"));
  if (port === null) return { ok: false, code: "pair_callback_invalid", redirect: null };
  const state = get("state");
  if (!checkState(state)) return { ok: false, code: "pair_request_invalid", redirect: null };
  const redirect = { port, state: state! };
  const refuse = (code: ErrorCode, details?: Record<string, unknown>): AuthorizeParse =>
    details ? { ok: false, code, redirect, details } : { ok: false, code, redirect };

  const range = checkVersion(get("v"));
  if (range) return refuse("protocol_unsupported", range);
  const challengeCode = checkChallenge(get("code_challenge"), get("code_challenge_method"));
  if (challengeCode) return refuse(challengeCode);
  const key = await checkMachinePubkey(get("machine_pubkey"));
  if (!key) return refuse("pair_request_invalid");
  if (!checkMachineName(get("machine_name"))) return refuse("machine_name_invalid");
  const originPort = checkOriginPort(get("origin_port"));
  if (originPort === null) return refuse("origin_port_invalid");
  if (!checkYaranVersion(get("yaran_version"))) return refuse("pair_request_invalid");

  const q: PairAuthorizeQuery = {
    v: Number(get("v")),
    state: state!,
    code_challenge: get("code_challenge")!,
    code_challenge_method: "S256",
    machine_pubkey: get("machine_pubkey")!,
    machine_name: get("machine_name")!,
    callback: get("callback")!,
    yaran_version: get("yaran_version")!,
    origin_port: originPort,
  };
  // Belt and braces: the coerced query must also satisfy 02's schema (unknown keys included).
  const known = new Set(["v", "state", "code_challenge", "code_challenge_method", "machine_pubkey", "machine_name", "callback", "yaran_version", "origin_port"]);
  if ([...params.keys()].some((k) => !known.has(k)) || !validate("PairAuthorizeQuery", q).valid) return refuse("pair_request_invalid");
  return {
    ok: true,
    q: {
      v: q.v,
      state: q.state,
      codeChallenge: q.code_challenge,
      machinePubkey: key,
      machinePubkeyB64: q.machine_pubkey,
      machineName: q.machine_name,
      callbackPort: port,
      originPort,
      yaranVersion: q.yaran_version,
    },
  };
}

/** The loopback callback with `code` or `error`, always echoing the state. */
export function callbackUrl(port: number, params: Record<string, string>): string {
  const u = new URL(`http://127.0.0.1:${port}/callback`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}
