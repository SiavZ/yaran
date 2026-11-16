/**
 * Machine test kit: Ed25519 key pairs and signed requests built with
 * `@yaran/protocol`'s signer (the same canonical string yaran signs in Rust).
 *
 * <module-headers:begin>
 * Uses:
 * test/helpers/machine.ts
 * ├── @yaran/protocol:src/index.ts
 * └── test/helpers/seed.ts
 * External: none
 *
 * Used by:
 * test/helpers/machine.ts
 * ├── test/helpers/matrix.ts
 * ├── test/machine-signature.test.ts
 * └── test/settings.test.ts
 * <module-headers:end>
 */
import { signMachineRequest } from "@yaran/protocol";
import { CP_HOST, NOW } from "./seed.ts";

export interface MachineKeys {
  privateKey: CryptoKey;
  publicKey: Uint8Array;
}

export async function machineKeys(): Promise<MachineKeys> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  return { privateKey: pair.privateKey, publicKey: new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer) };
}

export interface SignedOptions {
  keys: MachineKeys;
  machineId: string | null;
  path?: string;
  method?: string;
  body?: string;
  host?: string;
  timestamp?: number;
  nonce?: string;
  protocol?: string;
  query?: string;
}

/** A signed machine request (Yaran-Machine-Id omitted when machineId is null). */
export async function signedRequest(o: SignedOptions): Promise<Request> {
  const method = o.method ?? "POST";
  const path = o.path ?? "/v1/machine/probe";
  const host = o.host ?? CP_HOST;
  const body = new TextEncoder().encode(o.body ?? "");
  const headers = await signMachineRequest({
    method, path, host, protocol: o.protocol ?? "1", machineId: o.machineId, body,
    privateKey: o.keys.privateKey, timestamp: String(o.timestamp ?? NOW),
    ...(o.nonce ? { nonce: o.nonce } : {}),
  });
  const init: RequestInit = { method, headers: { ...headers, ...(body.length ? { "Content-Type": "application/json" } : {}) } };
  if (method !== "GET") init.body = body;
  return new Request(`https://${host}${path}${o.query ?? ""}`, init);
}
