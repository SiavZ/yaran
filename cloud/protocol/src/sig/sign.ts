/**
 * Signs a machine request (Design §7). yaran signs in Rust; this TS signer exists for the
 * Worker's tests and the mock machine Phase 19 drives, and it must produce exactly the
 * bytes the Rust signer does (pinned by `fixtures/sig/machine-request.json`).
 *
 * - Ed25519 signatures are deterministic (RFC 8032), so fixed inputs give fixed output.
 * - The nonce and timestamp are injectable for vectors; production lets them default.
 *
 * <module-headers:begin>
 * Uses:
 * src/sig/sign.ts
 * ├── src/b64url.ts
 * └── src/sig/canonical.ts
 * External: (none)
 *
 * Used by:
 * src/sig/sign.ts
 * ├── src/index.ts
 * └── test/sig.test.ts
 * <module-headers:end>
 */
import { b64urlEncode, utf8 } from "../b64url.ts";
import { machineCanonical, SIG_HEADERS, type MachineRequest } from "./canonical.ts";

export interface SignInput extends Omit<MachineRequest, "timestamp" | "nonce"> {
  /** Ed25519 private key with the "sign" usage. */
  privateKey: CryptoKey;
  timestamp?: string;
  nonce?: string;
}

/** Returns the SIG headers for the request (Yaran-Machine-Id omitted on the claim route). */
export async function signMachineRequest(input: SignInput): Promise<Record<string, string>> {
  const timestamp = input.timestamp ?? String(Math.floor(Date.now() / 1000));
  const nonce = input.nonce ?? b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
  const canonical = await machineCanonical({ ...input, timestamp, nonce });
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, input.privateKey, utf8.encode(canonical)));
  const headers: Record<string, string> = {
    [SIG_HEADERS.protocol]: input.protocol,
    [SIG_HEADERS.timestamp]: timestamp,
    [SIG_HEADERS.nonce]: nonce,
    [SIG_HEADERS.signature]: b64urlEncode(signature),
  };
  if (input.machineId !== null) headers[SIG_HEADERS.machineId] = input.machineId;
  return headers;
}
