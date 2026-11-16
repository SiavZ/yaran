/**
 * The sealed handoff envelope, JWE profile `yaran-handoff+jwe` v1 (Design §8, D8).
 *
 * `sealHandoff` is the Worker's sealer (W16b), built on jose's CompactEncrypt.
 * `openHandoff` is an independent WebCrypto opener that performs the eight opener
 * obligations in order and returns the registry code of the first one that fails; the
 * native openers (Phase 15) mirror it and pass the same fixtures.
 *
 * - Trust boundary: everything in the compact JWE is attacker-controlled until the
 *   AES-GCM tag verifies; the header is checked field by field before any ECDH.
 * - The recipient key is the phone's ephemeral key: one handoff, memory only.
 *
 * <module-headers:begin>
 * Uses:
 * src/jwe/handoff.ts
 * ├── src/b64url.ts
 * ├── src/generated/types.ts
 * ├── src/jwe/ec.ts
 * ├── src/jwe/kdf.ts
 * └── src/validate.ts
 * External: jose
 *
 * Used by:
 * src/jwe/handoff.ts
 * ├── src/index.ts
 * └── test/jwe.test.ts
 * <module-headers:end>
 */
import { CompactEncrypt } from "jose";
import { b64urlDecode, b64urlEncode, concatBytes, timingSafeEqual, utf8, utf8Decode } from "../b64url.ts";
import type { HandoffPayload, HandoffProtectedHeader } from "../generated/types.ts";
import { validate } from "../validate.ts";
import { decodeP256Point, importP256Public, jwkThumbprint, jwkToPoint, pointToJwk, type P256Jwk } from "./ec.ts";
import { concatKdf } from "./kdf.ts";

export const HANDOFF_ALG = "ECDH-ES";
export const HANDOFF_ENC = "A256GCM";
export const HANDOFF_TYP = "yaran-handoff+jwe";
export const HANDOFF_CTY = "yaran-handoff+json";
/** Plaintext cap (6 KiB) and the whole `jwe` callback parameter cap. */
export const HANDOFF_MAX_PLAINTEXT_BYTES = 6144;
export const HANDOFF_MAX_JWE_CHARS = 8192;
/** The opener refuses a payload whose exp is not at least this far ahead. */
export const HANDOFF_MIN_REMAINING_S = 60;

export type HandoffOpenError =
  | "jwe_malformed"
  | "jwe_unsupported"
  | "jwe_kid_mismatch"
  | "jwe_point_invalid"
  | "jwe_state_mismatch"
  | "jwe_host_mismatch"
  | "jwe_decrypt_failed"
  | "jwe_kind_mismatch"
  | "jwe_expired";

export interface SealInput {
  /** The phone's ephemeral recipient key as sent in `pk`. */
  recipientPk: string;
  /** The sealer's own served host (becomes `apu`). */
  host: string;
  /** The handoff state (becomes `apv`). */
  state: string;
  payload: HandoffPayload;
  /** Fixed ephemeral key and IV, for test vectors only; production always omits it. */
  testOnly?: { epkPrivateJwk: JsonWebKey; iv: Uint8Array };
}

/** Seals a handoff payload to the recipient key. Throws on an invalid input. */
export async function sealHandoff(input: SealInput): Promise<string> {
  const point = decodeP256Point(input.recipientPk);
  if (!point) throw new Error("recipient pk is not a valid P-256 point");
  if (!validate("HandoffPayload", input.payload).valid) throw new Error("payload fails the HandoffPayload schema");
  if (input.payload.host !== input.host) throw new Error("payload host must equal the sealer host");
  const plaintext = utf8.encode(JSON.stringify(input.payload));
  if (plaintext.length > HANDOFF_MAX_PLAINTEXT_BYTES) throw new Error("payload exceeds 6 KiB");

  const jwk = pointToJwk(point);
  const recipient = await importP256Public(point, "ECDH");
  const enc = new CompactEncrypt(plaintext).setProtectedHeader({
    alg: HANDOFF_ALG,
    enc: HANDOFF_ENC,
    typ: HANDOFF_TYP,
    cty: HANDOFF_CTY,
    kid: await jwkThumbprint(jwk),
  });
  const apu = utf8.encode(input.host);
  const apv = utf8.encode(input.state);
  if (input.testOnly) {
    const epk = await crypto.subtle.importKey("jwk", input.testOnly.epkPrivateJwk, { name: "ECDH", namedCurve: "P-256" }, true, [
      "deriveBits",
    ]);
    enc.setKeyManagementParameters({ apu, apv, epk }).setInitializationVector(input.testOnly.iv);
  } else {
    enc.setKeyManagementParameters({ apu, apv });
  }
  const jwe = await enc.encrypt(recipient);
  if (jwe.length > HANDOFF_MAX_JWE_CHARS) throw new Error("sealed envelope exceeds 8192 characters");
  return jwe;
}

export interface OpenInput {
  jwe: string;
  /** The ephemeral private key (ECDH, deriveBits) generated for this handoff. */
  recipientPrivateKey: CryptoKey;
  /** The same key's public half as sent in `pk`. */
  recipientPk: string;
  expectedHost: string;
  expectedState: string;
  expectedKind: HandoffPayload["kind"];
  /** Current Unix time in seconds. */
  now: number;
}

export type OpenResult =
  | { ok: true; payload: HandoffPayload; header: HandoffProtectedHeader }
  | { ok: false; code: HandoffOpenError };

function fail(code: HandoffOpenError): OpenResult {
  return { ok: false, code };
}

function decodeJson(part: string): Record<string, unknown> | null {
  const bytes = b64urlDecode(part);
  const text = bytes && utf8Decode(bytes);
  if (text === null || text === undefined) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Opens an envelope, enforcing opener obligations 1-7 in order (Design §8). */
export async function openHandoff(input: OpenInput): Promise<OpenResult> {
  // 1. Five parts, empty encrypted key, JSON header.
  const parts = input.jwe.split(".");
  if (parts.length !== 5 || parts[1] !== "") return fail("jwe_malformed");
  const [headerB64, , ivB64, ctB64, tagB64] = parts as [string, string, string, string, string];
  const header = decodeJson(headerB64);
  const iv = b64urlDecode(ivB64);
  const ct = b64urlDecode(ctB64);
  const tag = b64urlDecode(tagB64);
  if (!header || !iv || !ct || !tag || iv.length !== 12 || tag.length !== 16) return fail("jwe_malformed");

  // 2. Profile parameters.
  if (header.alg !== HANDOFF_ALG || header.enc !== HANDOFF_ENC || header.typ !== HANDOFF_TYP || header.cty !== HANDOFF_CTY) {
    return fail("jwe_unsupported");
  }

  // 3. kid is the thumbprint of this handoff's key.
  const ownPoint = decodeP256Point(input.recipientPk);
  if (!ownPoint) throw new Error("recipientPk is not a valid P-256 point");
  if (header.kid !== (await jwkThumbprint(pointToJwk(ownPoint)))) return fail("jwe_kid_mismatch");

  // 4. epk is a valid P-256 point.
  const epk = header.epk as Partial<P256Jwk> | undefined;
  if (!epk || typeof epk !== "object" || epk.kty !== "EC" || epk.crv !== "P-256") return fail("jwe_point_invalid");
  const epkPoint = jwkToPoint(epk);
  if (!epkPoint || !decodeP256Point(b64urlEncode(epkPoint))) return fail("jwe_point_invalid");

  // 5. apv is the stored state (constant time), apu the opened host.
  const apv = typeof header.apv === "string" ? b64urlDecode(header.apv) : null;
  if (!apv || !timingSafeEqual(apv, utf8.encode(input.expectedState))) return fail("jwe_state_mismatch");
  const apu = typeof header.apu === "string" ? b64urlDecode(header.apu) : null;
  if (!apu || utf8Decode(apu) !== input.expectedHost) return fail("jwe_host_mismatch");

  // 6. ECDH, Concat KDF, AES-256-GCM with the transmitted header as AAD.
  let plaintext: Uint8Array;
  try {
    const peer = await importP256Public(epkPoint, "ECDH");
    const z = new Uint8Array(
      // Cast: Workers' type names the field `$public`; the runtime reads `public` (WebCrypto).
      await crypto.subtle.deriveBits({ name: "ECDH", public: peer } as Parameters<SubtleCrypto["deriveBits"]>[0], input.recipientPrivateKey, 256),
    );
    const cek = await concatKdf(z, HANDOFF_ENC, apu, apv, 256);
    const key = await crypto.subtle.importKey("raw", cek as BufferSource, "AES-GCM", false, ["decrypt"]);
    plaintext = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: iv as BufferSource, additionalData: utf8.encode(headerB64) as BufferSource, tagLength: 128 },
        key,
        concatBytes(ct, tag) as BufferSource,
      ),
    );
  } catch {
    return fail("jwe_decrypt_failed");
  }

  // 7. Plaintext host, kind and expiry.
  const text = utf8Decode(plaintext);
  let payload: unknown;
  try {
    payload = text === null ? null : JSON.parse(text);
  } catch {
    payload = null;
  }
  if (!validate("HandoffPayload", payload).valid) return fail("jwe_malformed");
  const p = payload as HandoffPayload;
  if (p.host !== input.expectedHost) return fail("jwe_host_mismatch");
  if (p.kind !== input.expectedKind) return fail("jwe_kind_mismatch");
  if (!(p.exp > input.now + HANDOFF_MIN_REMAINING_S)) return fail("jwe_expired");
  return { ok: true, payload: p, header: header as unknown as HandoffProtectedHeader };
}

/** Imports a recipient private JWK (with d) for opening; tests and the Android shell use it. */
export function importRecipientPrivateJwk(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
}
