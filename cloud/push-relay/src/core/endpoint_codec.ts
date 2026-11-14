/**
 * Self-describing relay endpoints: `v1.<kid>.<opaque>`, where opaque is
 * base64url(nonce12 ‖ AES-256-GCM(ENDPOINT_KEYS[kid], compactJSON{p,t,e,b,k,r},
 * aad = "yaran-relay-endpoint-v1")).
 *
 * p is the channel (apns | fcm), t the device token, e the APNs environment (apns only), b
 * the app id, k the org's VAPID public key (base64url) and r the registration id. The relay
 * stores nothing: everything it needs to deliver is inside the endpoint, sealed so only the
 * relay can read it and nobody can forge one.
 *
 * - Key rotation: a new kid becomes current; old kids keep opening until retired.
 * - open() answers null for any defect (unknown kid, bad tag, bad shape); never throws.
 *
 * <module-headers:begin>
 * Uses:
 * src/core/endpoint_codec.ts
 * ├── @yaran/protocol:src/index.ts
 * └── src/core/config.ts
 * External: none
 *
 * Used by:
 * src/core/endpoint_codec.ts
 * ├── src/core/deps.ts
 * ├── src/core/mint.ts
 * └── src/core/receive.ts
 * <module-headers:end>
 */
import { b64urlDecode, b64urlEncode, concatBytes, decodeP256Point, utf8, utf8Decode } from "@yaran/protocol";
import type { ApnsEnvironment } from "./config.ts";

const AAD = utf8.encode("yaran-relay-endpoint-v1");
const SEGMENT = /^v1\.([A-Za-z0-9_-]{1,16})\.([A-Za-z0-9_-]{16,1024})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface EndpointKeys {
  current: string;
  keys: Map<string, CryptoKey>;
}

export type EndpointClaims =
  | { p: "apns"; t: string; e: ApnsEnvironment; b: string; k: string; r: string }
  | { p: "fcm"; t: string; b: string; k: string; r: string };

/** Imports ENDPOINT_KEYS; throws (naming the setting, not the value) when malformed. */
export async function importEndpointKeys(json: string): Promise<EndpointKeys> {
  const bad = () => new Error("relay secret ENDPOINT_KEYS must be {\"current\": kid, \"keys\": {kid: base64url of 32 bytes}}");
  let parsed: { current?: unknown; keys?: Record<string, unknown> };
  try {
    parsed = JSON.parse(json);
  } catch {
    throw bad();
  }
  if (typeof parsed.current !== "string" || typeof parsed.keys !== "object" || parsed.keys === null) throw bad();
  const keys = new Map<string, CryptoKey>();
  for (const [kid, value] of Object.entries(parsed.keys)) {
    const raw = typeof value === "string" ? b64urlDecode(value) : null;
    if (!/^[A-Za-z0-9_-]{1,16}$/.test(kid) || !raw || raw.length !== 32) throw bad();
    keys.set(kid, await crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]));
  }
  if (!keys.has(parsed.current)) throw bad();
  return { current: parsed.current, keys };
}

/** Seals claims under the current key; returns the `v1.<kid>.<opaque>` path segment. */
export async function sealEndpoint(keys: EndpointKeys, claims: EndpointClaims): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce as BufferSource, additionalData: AAD as BufferSource },
    keys.keys.get(keys.current)!,
    utf8.encode(JSON.stringify(claims)) as BufferSource,
  );
  return `v1.${keys.current}.${b64urlEncode(concatBytes(nonce, new Uint8Array(sealed)))}`;
}

/** The kid and claims of a segment, or null. */
export async function openEndpoint(keys: EndpointKeys, segment: string): Promise<{ kid: string; claims: EndpointClaims } | null> {
  const m = SEGMENT.exec(segment);
  const key = m && keys.keys.get(m[1]!);
  const blob = m && b64urlDecode(m[2]!);
  if (!m || !key || !blob || blob.length < 12 + 16) return null;
  let plain: Uint8Array;
  try {
    plain = new Uint8Array(
      await crypto.subtle.decrypt({ name: "AES-GCM", iv: blob.subarray(0, 12) as BufferSource, additionalData: AAD as BufferSource }, key, blob.subarray(12) as BufferSource),
    );
  } catch {
    return null;
  }
  const claims = parseClaims(utf8Decode(plain));
  return claims && { kid: m[1]!, claims };
}

function parseClaims(text: string | null): EndpointClaims | null {
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(text ?? "");
  } catch {
    return null;
  }
  const common = typeof v.t === "string" && v.t.length > 0 && typeof v.b === "string" && typeof v.k === "string" && decodeP256Point(v.k) !== null && typeof v.r === "string" && UUID.test(v.r);
  if (!common) return null;
  if (v.p === "apns" && (v.e === "production" || v.e === "sandbox")) return v as EndpointClaims;
  if (v.p === "fcm" && v.e === undefined) return v as EndpointClaims;
  return null;
}
