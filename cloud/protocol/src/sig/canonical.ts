/**
 * The one canonical string a machine signs (Design §7), plus the header names and
 * well-formedness rules every SIG request shares.
 *
 * Machine paths are restricted to `^/v1/machine/[a-z]+$` with no query, which removes
 * every percent-encoding and normalization ambiguity between ureq and the Workers URL
 * parser; this builder refuses anything else rather than signing it.
 *
 * - Pure apart from a WebCrypto SHA-256 of the body.
 * - The Rust twin is `yaran_core::cloud::protocol::signing::canonical_string`.
 *
 * <module-headers:begin>
 * Uses:
 * src/sig/canonical.ts
 * └── src/b64url.ts
 * External: (none)
 *
 * Used by:
 * src/sig/canonical.ts
 * ├── src/index.ts
 * ├── src/sig/sign.ts
 * ├── src/sig/verify.ts
 * └── test/sig.test.ts
 * <module-headers:end>
 */
import { sha256, toHex } from "../b64url.ts";

export const MACHINE_SIG_TAG = "yaran-machine-sig-v1";
export const MACHINE_PATH_RE = /^\/v1\/machine\/[a-z]+$/;
/** The only machine route that carries no Yaran-Machine-Id (the key comes from the pair code). */
export const CLAIM_PATH = "/v1/machine/claim";
export const EMPTY_BODY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
/** Server accepts timestamps within this many seconds of its clock. */
export const MACHINE_SIG_SKEW_S = 300;
/** A nonce is remembered until timestamp + this many seconds. */
export const MACHINE_NONCE_TTL_S = 600;
export const MAX_BODY_BYTES = 64 * 1024;

export const SIG_HEADERS = {
  protocol: "Yaran-Protocol",
  machineId: "Yaran-Machine-Id",
  timestamp: "Yaran-Timestamp",
  nonce: "Yaran-Nonce",
  signature: "Yaran-Signature",
} as const;

export const TIMESTAMP_RE = /^(?:0|[1-9][0-9]{0,11})$/;
export const NONCE_RE = /^[A-Za-z0-9_-]{21}[AQgw]$/;
export const SIGNATURE_RE = /^[A-Za-z0-9_-]{85}[AQgw]$/;
export const PROTOCOL_HEADER_RE = /^[1-9][0-9]{0,4}$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface MachineRequest {
  method: string;
  /** The request target exactly as sent; must match MACHINE_PATH_RE. */
  path: string;
  /** The Host header; lowercased and stripped of any port here. */
  host: string;
  protocol: string;
  /** Null on the claim route only. */
  machineId: string | null;
  timestamp: string;
  nonce: string;
  body: Uint8Array;
}

/** Host as signed: lowercase, port removed (Design §7). */
export function signedHost(host: string): string {
  return host.toLowerCase().replace(/:[0-9]*$/, "");
}

/** Lowercase hex SHA-256 of the exact body bytes. */
export async function bodySha256Hex(body: Uint8Array): Promise<string> {
  return toHex(await sha256(body));
}

/** Builds the canonical string. Throws when the path breaks the machine path rule. */
export async function machineCanonical(req: MachineRequest): Promise<string> {
  if (!MACHINE_PATH_RE.test(req.path)) throw new Error(`not a signable machine path: ${req.path}`);
  return [
    MACHINE_SIG_TAG,
    req.method.toUpperCase(),
    req.path,
    signedHost(req.host),
    req.protocol,
    req.machineId ?? "-",
    req.timestamp,
    req.nonce,
    await bodySha256Hex(req.body),
  ].join("\n");
}
