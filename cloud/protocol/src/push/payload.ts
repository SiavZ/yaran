/**
 * The push plaintext payload v1 (Design §9): building it from a machine Event, its
 * byte-exact serialization with the 320-byte cap, and the device-side parse.
 *
 * `p` and `l` are truncated on a UTF-8 character boundary to at most 21 bytes plus "…"
 * when longer than 24 bytes. `s` is a token (RowState or ending), never display text;
 * the device words it. Keys serialize in the fixed order v, k, m, a, t, s, p, l, ts so
 * every language produces the same bytes.
 *
 * - Trust boundary on the device: the decrypted bytes are parsed strictly; anything
 *   else is push_payload_invalid and the generic notification text stays.
 *
 * <module-headers:begin>
 * Uses:
 * src/push/payload.ts
 * ├── src/b64url.ts
 * ├── src/generated/types.ts
 * └── src/validate.ts
 * External: none
 *
 * Used by:
 * src/push/payload.ts
 * ├── src/index.ts
 * └── test/push.test.ts
 * <module-headers:end>
 */
import { utf8, utf8Decode } from "../b64url.ts";
import type { Event, PushPayload } from "../generated/types.ts";
import { validate } from "../validate.ts";

export const PUSH_PAYLOAD_MAX_BYTES = 320;
export const PUSH_TEXT_MAX_BYTES = 24;
const ELLIPSIS = "…";

/** Truncates to at most 24 UTF-8 bytes: 21 bytes on a character boundary plus "…". */
export function truncateUtf8(text: string): string {
  if (utf8.encode(text).length <= PUSH_TEXT_MAX_BYTES) return text;
  let out = "";
  let bytes = 0;
  for (const ch of text) {
    const n = utf8.encode(ch).length;
    if (bytes + n > PUSH_TEXT_MAX_BYTES - 3) break;
    out += ch;
    bytes += n;
  }
  return out + ELLIPSIS;
}

const KEY_ORDER = ["v", "k", "m", "a", "t", "s", "p", "l", "ts"] as const;

/** Serializes with the fixed key order; throws when over the 320-byte cap. */
export function serializePushPayload(payload: PushPayload): Uint8Array {
  const ordered: Record<string, unknown> = {};
  for (const key of KEY_ORDER) if (payload[key] !== undefined) ordered[key] = payload[key];
  const bytes = utf8.encode(JSON.stringify(ordered));
  if (bytes.length > PUSH_PAYLOAD_MAX_BYTES) throw new Error(`push payload is ${bytes.length} bytes, over the 320-byte cap`);
  return bytes;
}

/**
 * Serializes a payload for sending. Over the cap (only reachable with ids far longer than
 * today's UUIDs) it drops `p` and `l`, the shape the device already words for
 * `detail = minimal`, and sends that; null when even that is over, and the sender logs and
 * drops the push. Ids are never cut: `a` and `t` are where a tap lands.
 */
export function fitPushPayload(payload: PushPayload): Uint8Array | null {
  for (const candidate of [payload, { ...payload, p: undefined, l: undefined }]) {
    try {
      return serializePushPayload(candidate);
    } catch {
      // over the cap: try the next, smaller candidate
    }
  }
  return null;
}

/** The payload for one accepted machine event. */
export function eventToPayload(event: Event, machineId: string): PushPayload {
  const payload: PushPayload = {
    v: 1,
    k: event.kind,
    m: machineId,
    a: event.agent_id,
    s: event.kind === "agent_exited_badly" ? event.ending : event.state,
    ts: Math.floor(Date.parse(event.ts) / 1000),
  };
  if (event.tab_id !== undefined) payload.t = event.tab_id;
  if (event.project) payload.p = truncateUtf8(event.project);
  if (event.label) payload.l = truncateUtf8(event.label);
  return payload;
}

/** The `test` payload (W15). */
export function testPayload(ts: number): PushPayload {
  return { v: 1, k: "test", ts };
}

export type ParsedPush = { ok: true; payload: PushPayload } | { ok: false; code: "push_payload_invalid" };

/** Parses decrypted push bytes on the device. */
export function parsePushPayload(bytes: Uint8Array): ParsedPush {
  const invalid: ParsedPush = { ok: false, code: "push_payload_invalid" };
  if (bytes.length > PUSH_PAYLOAD_MAX_BYTES) return invalid;
  const text = utf8Decode(bytes);
  if (text === null) return invalid;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return invalid;
  }
  if (!validate("PushPayload", value).valid) return invalid;
  const payload = value as PushPayload;
  for (const s of [payload.p, payload.l]) {
    if (s !== undefined && utf8.encode(s).length > PUSH_TEXT_MAX_BYTES) return invalid;
  }
  return { ok: true, payload };
}
