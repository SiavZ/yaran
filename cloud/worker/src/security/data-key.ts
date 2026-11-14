/**
 * Encryption at rest for every secret the Worker generates, rooted in the `DATA_KEY`
 * Deploy-time secret, plus the one MAC key (the remembered handoff consent, D24).
 *
 * - Key: HKDF-SHA256(DATA_KEY, salt "yaran-cloud", info "v1/<purpose>"), 256 bits per
 *   purpose. Not used for the handoff envelope, which is 02's JWE (Concat KDF).
 * - Cipher: AES-256-GCM, random 96-bit IV, AAD `"<table>.<column>:<row id>"`, so a
 *   ciphertext copied to another row or column fails to open. A settings row uses table
 *   `settings`, column `value`, row id = the key.
 * - Stored form: `k<version>.<b64url iv>.<b64url ct>`.
 * - Version: the `data_key_state` settings row records `{version, check, previous_check}`
 *   where `check` is a one-way 16-byte fingerprint of the key. A new DATA_KEY bumps the
 *   version exactly once (conditional write; a losing isolate re-reads). DATA_KEY_PREVIOUS
 *   opens `k<version − 1>` only while its check equals `previous_check`; it never verifies
 *   a MAC, so a rotation forgets every remembered consent.
 *
 * Purposes are a closed union; a later phase adds its own here.
 *
 * <module-headers:begin>
 * Uses:
 * src/security/data-key.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/db/settings.ts
 * ├── src/http/context.ts
 * ├── src/http/responses.ts
 * └── src/security/secrets.ts
 * External: none
 *
 * Used by:
 * src/security/data-key.ts
 * ├── src/routes/call.ts
 * ├── src/routes/phase06-context.ts
 * ├── src/scheduled/purge.ts
 * ├── test/data-key.test.ts
 * ├── test/no-secret-leak.test.ts
 * └── test/sessions/handoff-remembered.test.ts
 * <module-headers:end>
 */
import { b64urlDecode, b64urlEncode } from "@yaran/protocol";
import { compareAndSetSetting, getSetting, type DataKeyState } from "../db/settings.ts";
import type { AppContext } from "../http/context.ts";
import { HttpError } from "../http/responses.ts";
import { decodeDataKey } from "./secrets.ts";

export type SealPurpose = "vapid" | "device_endpoint" | "device_auth" | "pair_state";
export type MacPurpose = "handoff_consent";
type Purpose = SealPurpose | MacPurpose | "key_check";

export const DATA_KEY_SALT = "yaran-cloud";
const utf8 = new TextEncoder();

/** HKDF-SHA256 of the root key for one purpose: 32 raw bytes. */
export async function deriveKey(root: Uint8Array, purpose: Purpose): Promise<Uint8Array> {
  const base = await crypto.subtle.importKey("raw", root as BufferSource, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: utf8.encode(DATA_KEY_SALT), info: utf8.encode(`v1/${purpose}`) }, base, 256);
  return new Uint8Array(bits);
}

/** The one-way identity of a root key (first 16 bytes of the key_check purpose key). */
export async function keyCheck(root: Uint8Array): Promise<string> {
  return b64urlEncode((await deriveKey(root, "key_check")).slice(0, 16));
}

/** A failed open: loud, names the purpose, never the key. */
export class DataKeyError extends Error {
  constructor(readonly purpose: SealPurpose, reason: string) {
    super(`cannot open the ${purpose} secret: ${reason}`);
  }
}

export interface KeyRing {
  version: number;
  current: Uint8Array;
  /** DATA_KEY_PREVIOUS, only when it matches the recorded previous_check. */
  previous: Uint8Array | null;
}

let cached: { dataKey: string; previous: string | undefined; ring: KeyRing } | null = null;

/** Test hook: behave like a fresh isolate. */
export function resetKeyRingCache(): void {
  cached = null;
}

async function resolveState(ctx: AppContext, check: string): Promise<DataKeyState> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const state = await getSetting(ctx.db, "data_key_state");
    if (state === null) {
      const first: DataKeyState = { version: 1, check, previous_check: null };
      if (await compareAndSetSetting(ctx.db, "data_key_state", null, first, ctx.now())) return first;
      continue;
    }
    if (state.check === check) return state;
    if (state.previous_check === check) {
      ctx.log.error("data_key_stale", { action: "This isolate holds the DATA_KEY that was rotated out; it refuses to seal until it is replaced." });
      throw new HttpError("unavailable", "The Worker is finishing a key rotation; try again shortly.");
    }
    const next: DataKeyState = { version: state.version + 1, check, previous_check: state.check };
    if (await compareAndSetSetting(ctx.db, "data_key_state", state, next, ctx.now())) {
      ctx.log.warn("data_key_rotated", { version: next.version, action: "Set DATA_KEY_PREVIOUS to the old key until the reseal task reports it is safe to remove." });
      return next;
    }
  }
  throw new HttpError("unavailable", "The data key state could not be settled; try again shortly.");
}

/** The current key version and keys, resolved once per isolate. */
export async function keyRing(ctx: AppContext): Promise<KeyRing> {
  const dataKey = ctx.env.DATA_KEY ?? "";
  if (cached && cached.dataKey === dataKey && cached.previous === ctx.env.DATA_KEY_PREVIOUS) return cached.ring;
  const current = decodeDataKey(dataKey);
  if (!current) throw new HttpError("unavailable", "The DATA_KEY secret is missing or malformed.");
  const state = await resolveState(ctx, await keyCheck(current));
  let previous: Uint8Array | null = null;
  if (ctx.env.DATA_KEY_PREVIOUS) {
    const candidate = decodeDataKey(ctx.env.DATA_KEY_PREVIOUS);
    if (candidate && state.previous_check !== null && (await keyCheck(candidate)) === state.previous_check) previous = candidate;
    else ctx.log.warn("data_key_previous_ignored", { secret_name: "DATA_KEY_PREVIOUS", action: "It does not match the key that was rotated out; fix or remove DATA_KEY_PREVIOUS." });
  }
  const ring = { version: state.version, current, previous };
  cached = { dataKey, previous: ctx.env.DATA_KEY_PREVIOUS, ring };
  return ring;
}

export interface SealAad {
  table: string;
  column: string;
  rowId: string;
}

const aadBytes = (a: SealAad) => utf8.encode(`${a.table}.${a.column}:${a.rowId}`);

async function aesKey(root: Uint8Array, purpose: SealPurpose): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", (await deriveKey(root, purpose)) as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** Seals `plaintext` for one row and column under the current key version. */
export async function seal(ctx: AppContext, purpose: SealPurpose, aad: SealAad, plaintext: Uint8Array | string): Promise<string> {
  const ring = await keyRing(ctx);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = typeof plaintext === "string" ? utf8.encode(plaintext) : plaintext;
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aadBytes(aad) }, await aesKey(ring.current, purpose), data as BufferSource);
  return `k${ring.version}.${b64urlEncode(iv)}.${b64urlEncode(new Uint8Array(ct))}`;
}

const SEALED_RE = /^k([1-9][0-9]{0,8})\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]+)$/;

/** The key version a stored value was sealed under, or null when it is not sealed. */
export function sealedVersion(stored: string): number | null {
  const m = SEALED_RE.exec(stored);
  return m ? Number(m[1]) : null;
}

/** Opens a sealed value; throws DataKeyError naming the purpose on any failure. */
export async function open(ctx: AppContext, purpose: SealPurpose, aad: SealAad, stored: string): Promise<Uint8Array> {
  const m = SEALED_RE.exec(stored);
  const iv = m ? b64urlDecode(m[2]!) : null;
  const ct = m ? b64urlDecode(m[3]!) : null;
  if (!m || !iv || !ct) throw new DataKeyError(purpose, "the stored value is not in the sealed format");
  const ring = await keyRing(ctx);
  const version = Number(m[1]);
  const root = version === ring.version ? ring.current : version === ring.version - 1 ? ring.previous : null;
  if (!root) throw new DataKeyError(purpose, `it was sealed under key version ${version} and this Worker holds version ${ring.version}`);
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource, additionalData: aadBytes(aad) }, await aesKey(root, purpose), ct as BufferSource);
    return new Uint8Array(pt);
  } catch {
    throw new DataKeyError(purpose, "authentication failed (wrong key, row or column, or tampered data)");
  }
}

/** The MAC key for a purpose and the version (`kv`) it belongs to; only the current key. */
export async function macKey(ctx: AppContext, purpose: MacPurpose): Promise<{ kv: number; key: Uint8Array }> {
  const ring = await keyRing(ctx);
  return { kv: ring.version, key: await deriveKey(ring.current, purpose) };
}
