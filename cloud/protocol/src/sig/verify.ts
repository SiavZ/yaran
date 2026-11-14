/**
 * Verifies a machine request (Design §7) in the normative order, returning the registry
 * code of the first failing step. The Worker (Phase 04) supplies key lookup and nonce
 * storage through the two interfaces below; everything else is decided here, once.
 *
 * Order: headers well-formed [signature_missing], protocol in range
 * [protocol_unsupported], body size [payload_too_large], path rule [signature_invalid],
 * clock skew [signature_expired], key lookup [machine_unknown | pair_code_invalid],
 * signature [signature_invalid], revocation [machine_revoked], nonce [nonce_replayed].
 *
 * - Trust boundary: every header and the body are attacker-controlled.
 * - Revocation is reported only after a valid signature, so strangers learn nothing.
 * - UNVERIFIED-1: Workers' raw import of an Ed25519 public key; the JWK import fallback
 *   needs no protocol change (Phase 04 runs this suite under workerd).
 *
 * <module-headers:begin>
 * Uses:
 * src/sig/verify.ts
 * ├── src/b64url.ts
 * └── src/sig/canonical.ts
 * External: (none)
 *
 * Used by:
 * src/sig/verify.ts
 * ├── src/index.ts
 * └── test/sig.test.ts
 * <module-headers:end>
 */
import { b64urlDecode, utf8 } from "../b64url.ts";
import {
  CLAIM_PATH,
  machineCanonical,
  MACHINE_NONCE_TTL_S,
  MACHINE_PATH_RE,
  MACHINE_SIG_SKEW_S,
  MAX_BODY_BYTES,
  NONCE_RE,
  PROTOCOL_HEADER_RE,
  SIG_HEADERS,
  SIGNATURE_RE,
  TIMESTAMP_RE,
  UUID_RE,
} from "./canonical.ts";

export interface MachineKey {
  /** 32 raw Ed25519 public-key bytes. */
  publicKey: Uint8Array;
  revoked: boolean;
}

export interface MachineKeyLookup {
  byMachineId(machineId: string): Promise<MachineKey | null>;
  /** The claim route: the key recorded with the pair code (never revoked). */
  byPairCode(code: string): Promise<MachineKey | null>;
}

export interface NonceStore {
  /** Records (scope, nonce) until expiresAt (Unix s); false when it was already recorded. */
  recordIfNew(scope: string, nonce: string, expiresAt: number): Promise<boolean>;
}

export interface VerifyInput {
  method: string;
  path: string;
  host: string;
  /** Header lookup, case-insensitive (a Headers instance satisfies it). */
  headers: { get(name: string): string | null };
  body: Uint8Array;
  /** Server clock, Unix seconds. */
  now: number;
  protocol: { min: number; max: number };
  /** The pair code from the claim body; required on the claim route. */
  claimCode?: string;
  keys: MachineKeyLookup;
  nonces: NonceStore;
}

export type VerifyFailure =
  | "signature_missing"
  | "protocol_unsupported"
  | "payload_too_large"
  | "signature_invalid"
  | "signature_expired"
  | "machine_unknown"
  | "pair_code_invalid"
  | "machine_revoked"
  | "nonce_replayed";

export type VerifyResult =
  | { ok: true; machineId: string | null; protocol: number }
  | { ok: false; code: VerifyFailure; details?: Record<string, unknown> };

const fail = (code: VerifyFailure, details?: Record<string, unknown>): VerifyResult =>
  details ? { ok: false, code, details } : { ok: false, code };

/** Verifies the request; see the module comment for the order. */
export async function verifyMachineRequest(input: VerifyInput): Promise<VerifyResult> {
  const h = (name: string) => input.headers.get(name);
  const protocol = h(SIG_HEADERS.protocol);
  const machineId = h(SIG_HEADERS.machineId);
  const timestamp = h(SIG_HEADERS.timestamp);
  const nonce = h(SIG_HEADERS.nonce);
  const signature = h(SIG_HEADERS.signature);
  const isClaim = input.path === CLAIM_PATH;

  // 1. Headers present and well-formed; the claim route alone carries no machine id.
  if (
    protocol === null || !PROTOCOL_HEADER_RE.test(protocol) ||
    timestamp === null || !TIMESTAMP_RE.test(timestamp) ||
    nonce === null || !NONCE_RE.test(nonce) ||
    signature === null || !SIGNATURE_RE.test(signature) ||
    (isClaim ? machineId !== null || !input.claimCode : machineId === null || !UUID_RE.test(machineId))
  ) {
    return fail("signature_missing");
  }
  const version = Number(protocol);
  if (version < input.protocol.min || version > input.protocol.max) {
    return fail("protocol_unsupported", { min: input.protocol.min, max: input.protocol.max });
  }
  if (input.body.length > MAX_BODY_BYTES) return fail("payload_too_large");
  if (!MACHINE_PATH_RE.test(input.path)) return fail("signature_invalid");

  // 2. Clock skew.
  const ts = Number(timestamp);
  if (Math.abs(input.now - ts) > MACHINE_SIG_SKEW_S) {
    return fail("signature_expired", { server_time: new Date(input.now * 1000).toISOString().replace(/\.\d{3}Z$/, "Z") });
  }

  // 3. Key.
  const key = isClaim ? await input.keys.byPairCode(input.claimCode!) : await input.keys.byMachineId(machineId!);
  if (!key) return fail(isClaim ? "pair_code_invalid" : "machine_unknown");

  // 4. Signature over the canonical string, body hash recomputed from the received bytes.
  const canonical = await machineCanonical({
    method: input.method,
    path: input.path,
    host: input.host,
    protocol,
    machineId: isClaim ? null : machineId,
    timestamp,
    nonce,
    body: input.body,
  });
  let verified = false;
  try {
    const publicKey = await crypto.subtle.importKey("raw", key.publicKey as BufferSource, { name: "Ed25519" }, false, ["verify"]);
    verified = await crypto.subtle.verify({ name: "Ed25519" }, publicKey, b64urlDecode(signature)! as BufferSource, utf8.encode(canonical));
  } catch {
    verified = false;
  }
  if (!verified) return fail("signature_invalid");

  // 5. Revocation, only after a valid signature.
  if (key.revoked) return fail("machine_revoked");

  // 6. Replay.
  const scope = isClaim ? `claim:${input.claimCode}` : machineId!;
  if (!(await input.nonces.recordIfNew(scope, nonce, ts + MACHINE_NONCE_TTL_S))) return fail("nonce_replayed");
  return { ok: true, machineId: isClaim ? null : machineId, protocol: version };
}
