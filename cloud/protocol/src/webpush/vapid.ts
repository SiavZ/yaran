/**
 * VAPID (RFC 8292): signing the org Worker's `Authorization: vapid t=<jwt>, k=<key>` header
 * and verifying it at the publisher relay.
 *
 * The JWT is ES256 over `{"typ":"JWT","alg":"ES256"}` with claims `aud` (push resource
 * origin), `exp` (at most 24 h ahead) and an optional `sub`. The relay additionally binds
 * `k` to the key embedded in the endpoint at mint, so a leaked endpoint is useless without
 * that org's private key.
 *
 * - WebCrypto ECDSA P-256 with raw r‖s signatures (the JWS form); no JWT library.
 * - verifyVapid answers with the relay's registry codes and never throws on hostile input.
 *
 * <module-headers:begin>
 * Uses:
 * src/webpush/vapid.ts
 * ├── src/b64url.ts
 * └── src/jwe/ec.ts
 * External: none
 *
 * Used by:
 * src/webpush/vapid.ts
 * ├── src/index.ts
 * └── test/webpush.test.ts
 * <module-headers:end>
 */
import { b64urlDecode, b64urlEncode, timingSafeEqual, utf8, utf8Decode } from "../b64url.ts";
import { decodeP256Point, importP256Public, jwkToPoint } from "../jwe/ec.ts";

/** RFC 8292 §2: a token's exp may be at most 24 hours ahead. */
export const VAPID_MAX_LIFETIME_S = 24 * 3600;
const JWT_HEADER = b64urlEncode(utf8.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));

export interface VapidSigner {
  privateKey: CryptoKey;
  /** The 65-byte raw public point, sent as `k`. */
  publicRaw: Uint8Array;
}

export interface VapidClaims {
  aud: string;
  exp: number;
  sub?: string;
}

/** Imports the org's stored private JWK (Phase 07 generates it) as a VAPID signer. */
export async function importVapidPrivateJwk(jwk: JsonWebKey): Promise<VapidSigner> {
  const publicRaw = jwkToPoint(jwk);
  if (!publicRaw || jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.d !== "string") {
    throw new Error("the VAPID private key is not a P-256 private JWK");
  }
  const { kty, crv, x, y, d } = jwk;
  const privateKey = await crypto.subtle.importKey("jwk", { kty, crv, x, y, d } as JsonWebKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  return { privateKey, publicRaw };
}

/** Signs a VAPID JWT and returns the whole `Authorization` header value. */
export async function signVapid(signer: VapidSigner, claims: VapidClaims): Promise<string> {
  const body: Record<string, unknown> = { aud: claims.aud, exp: claims.exp };
  if (claims.sub !== undefined) body.sub = claims.sub;
  const input = `${JWT_HEADER}.${b64urlEncode(utf8.encode(JSON.stringify(body)))}`;
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signer.privateKey, utf8.encode(input) as BufferSource);
  return `vapid t=${input}.${b64urlEncode(new Uint8Array(sig))}, k=${b64urlEncode(signer.publicRaw)}`;
}

/** Splits `vapid t=…, k=…` (parameters in any order, scheme case-insensitive); null when malformed. */
export function parseVapidHeader(value: string | null | undefined): { jwt: string; k: string } | null {
  if (!value) return null;
  const m = /^\s*vapid\s+(.+)$/i.exec(value);
  if (!m) return null;
  const params = new Map<string, string>();
  for (const part of m[1]!.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) return null;
    const name = part.slice(0, eq).trim().toLowerCase();
    if (params.has(name)) return null;
    params.set(name, part.slice(eq + 1).trim());
  }
  const jwt = params.get("t");
  const k = params.get("k");
  if (!jwt || !k || params.size !== 2) return null;
  return { jwt, k };
}

export type VapidVerdict =
  | { ok: true; claims: VapidClaims }
  | { ok: false; code: "relay_vapid_invalid" | "relay_vapid_mismatch" };

export interface VapidExpectation {
  /** The 65-byte key bound at mint. */
  boundKey: Uint8Array;
  /** The relay's own origin, which `aud` must equal. */
  audience: string;
  /** Unix seconds. */
  now: number;
}

/** Verifies an `Authorization` header against the bound key, audience and lifetime. */
export async function verifyVapid(header: string | null | undefined, want: VapidExpectation): Promise<VapidVerdict> {
  const invalid: VapidVerdict = { ok: false, code: "relay_vapid_invalid" };
  const parsed = parseVapidHeader(header);
  if (!parsed) return invalid;
  const k = decodeP256Point(parsed.k);
  if (!k || !timingSafeEqual(k, want.boundKey)) return { ok: false, code: "relay_vapid_mismatch" };
  const parts = parsed.jwt.split(".");
  if (parts.length !== 3) return invalid;
  const [h, c, s] = parts as [string, string, string];
  const jose = parseJson(h);
  const claims = parseJson(c);
  const sig = b64urlDecode(s);
  if (!jose || jose.alg !== "ES256" || !claims || !sig || sig.length !== 64) return invalid;
  const key = await importP256Public(k, "ECDSA");
  const good = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sig as BufferSource, utf8.encode(`${h}.${c}`) as BufferSource);
  if (!good) return invalid;
  const { aud, exp, sub } = claims;
  if (aud !== want.audience || typeof exp !== "number" || !Number.isInteger(exp)) return invalid;
  if (exp <= want.now || exp > want.now + VAPID_MAX_LIFETIME_S) return invalid;
  if (sub !== undefined && typeof sub !== "string") return invalid;
  return { ok: true, claims: sub === undefined ? { aud, exp } : { aud, exp, sub } };
}

function parseJson(segment: string): Record<string, unknown> | null {
  const bytes = b64urlDecode(segment);
  const text = bytes && utf8Decode(bytes);
  if (!text) return null;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
