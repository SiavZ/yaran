/**
 * Wizard step 8: the org's VAPID key pair for Web Push.
 *
 * Generates an extractable ECDSA P-256 pair, seals the private JWK with 04's DATA_KEY
 * helper (it is never shown or exported again), and stores the 65-byte raw public key,
 * base64url, as `vapid_public_key`, which 06 serves as `Meta.push.vapid_public_key` and 08
 * signs with. Re-running reuses an existing pair; the admin rotation overwrites it.
 *
 * <module-headers:begin>
 * Uses:
 * src/setup/steps/keys.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/admin/ports.ts
 * ├── src/admin/settings-store.ts
 * └── src/setup/wizard-state.ts
 * External: none
 *
 * Used by:
 * src/setup/steps/keys.ts
 * ├── src/admin/vapid-rotate.ts
 * ├── src/setup/routes.ts
 * ├── test/setup-steps.test.ts
 * └── test/vapid-rotate.test.ts
 * <module-headers:end>
 */
import { b64urlEncode } from "@yaran/protocol";
import type { DataKeySealer } from "../../admin/ports.ts";
import { readKey, writeKeys } from "../../admin/settings-store.ts";
import type { SetupEvent } from "../wizard-state.ts";

export const VAPID_PUBLIC_KEY = "vapid_public_key";
export const VAPID_PRIVATE_KEY = "vapid_private_key_enc";
/** 04's settings AAD rule, so the reseal task can reopen it (08 opens it to sign). */
export const VAPID_AAD = { table: "settings", column: "value", rowId: VAPID_PRIVATE_KEY } as const;

export async function ensureVapidKey(db: D1Database, sealer: DataKeySealer, now: Date): Promise<SetupEvent> {
  const existing = await readKey<string>(db, VAPID_PUBLIC_KEY);
  if (existing && (await readKey<string>(db, VAPID_PRIVATE_KEY))) return { kind: "keys_ready", vapid_public_key: existing };
  return { kind: "keys_ready", vapid_public_key: await writeNewVapidKey(db, sealer, now, "setup") };
}

/** Generates a fresh pair and overwrites whatever was stored; returns the public key. */
export async function writeNewVapidKey(db: D1Database, sealer: DataKeySealer, now: Date, actor: string): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const publicKey = b64urlEncode(raw);
  await writeKeys(db, { [VAPID_PUBLIC_KEY]: publicKey, [VAPID_PRIVATE_KEY]: await sealer.seal("vapid", VAPID_AAD, JSON.stringify(jwk)) }, actor, now);
  return publicKey;
}

/** The VAPID `sub` claim: the control plane's own origin. */
export function vapidSubject(cpHost: string): string {
  return `https://${cpHost}`;
}
