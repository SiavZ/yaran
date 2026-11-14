/**
 * Generates `fixtures/push/`: event-to-payload vectors with exact serialized bytes,
 * UTF-8 truncation at multi-byte boundaries, the 320-byte cap, topic derivation and the
 * per-kind delivery table, device-side parse cases, and the relay's APNs/FCM wrapping
 * (Design §9).
 *
 * The serializer here is written independently of src/push so the TS suite checks one
 * implementation against another.
 *
 * <module-headers:begin>
 * Uses: none
 * External: node:crypto
 *
 * Used by:
 * scripts/vectors/push.mjs
 * └── scripts/gen-vectors.mjs
 * <module-headers:end>
 */
import { createHash } from "node:crypto";

const M = "6f1c2a9e-3b4d-4e5f-8a7b-9c0d1e2f3a4b";
const A = "1d2e3f40-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const T = "9a8b7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d";
const TS = "2024-11-14T08:00:00Z";
const bytes = (s) => Buffer.byteLength(s, "utf8");

function truncate(s) {
  if (bytes(s) <= 24) return s;
  let out = "";
  for (const ch of s) {
    if (bytes(out + ch) > 21) break;
    out += ch;
  }
  return `${out}…`;
}

function toPayload(e) {
  const p = { v: 1, k: e.kind, m: M, a: e.agent_id };
  if (e.tab_id !== undefined) p.t = e.tab_id;
  p.s = e.kind === "agent_exited_badly" ? e.ending : e.state;
  if (e.project) p.p = truncate(e.project);
  if (e.label) p.l = truncate(e.label);
  p.ts = Date.parse(e.ts) / 1000;
  return p;
}

let n = 0;
const id = () => `0b8e4c1d-2f3a-4b5c-9d6e-${(++n).toString(16).padStart(12, "0")}`;
const att = (over) => ({ id: id(), kind: "attention_raised", ts: TS, agent_id: A, state: "needs_attention", ...over });
const exit = (ending, over) => ({ id: id(), kind: "agent_exited_badly", ts: TS, agent_id: A, ending, exit_status: 1, ...over });

function events() {
  n = 0;
  const cases = [
    ["raised on the slot tab with names", att({ project: "yaran", label: "fix the tests" })],
    ["raised on an extra tab", att({ tab_id: T, project: "yaran", label: "fix the tests" })],
    ["raised with push.detail minimal", att({})],
    ...["typing", "busy", "idle", "detached", "exited"].map((s) => [`cleared to ${s}`, att({ kind: "attention_cleared", state: s, tab_id: T })]),
    ...["launch_failed", "exited", "exited_unknown", "rapid_clean_exit"].map((e) => [`exited badly: ${e}`, exit(e, { project: "yaran", label: "agent" })]),
    ["long ASCII project is truncated", att({ project: "a-very-long-project-name-indeed", label: "short" })],
    ["CJK label of exactly 24 bytes is kept", att({ label: "日本語のラベルで" })],
    ["CJK label over 24 bytes is truncated", att({ label: "日本語のラベルです" })],
    ["emoji at the 24-byte boundary is kept", att({ label: "abcdefghijklmnopqrst😀" })],
    ["emoji crossing the 21-byte cut is dropped whole", att({ label: "abcdefghijklmnopqrst😀x" })],
    ["empty project and label are omitted", att({ project: "", label: "" })],
  ];
  const out = cases.map(([name, event]) => {
    const payload = toPayload(event);
    const serialized = JSON.stringify(payload);
    if (bytes(serialized) > 320) throw new Error(`${name} is over the cap`);
    return { name, machine_id: M, event, payload, serialized, bytes: bytes(serialized) };
  });
  const longId = "x".repeat(128);
  const big = att({ agent_id: longId, tab_id: longId, project: "p".repeat(64), label: "l".repeat(64) });
  const bigSerialized = JSON.stringify(toPayload(big));
  return {
    description: "Machine Event -> PushPayload v1. serialized is the exact UTF-8 JSON (key order v,k,m,a,t,s,p,l,ts); exit_status never reaches the payload.",
    cases: out,
    refused: [{ name: "128-character ids exceed the 320-byte cap", machine_id: M, event: big, serialized_bytes: bytes(bigSerialized), expect: "too_large" }],
  };
}

function truncation() {
  const inputs = ["short", "exactly-twenty-four-byte", "twenty-five-bytes-of-text", "日本語のラベルで", "日本語のラベルです", "abcdefghijklmnopqrst😀", "abcdefghijklmnopqrst😀x", "abcdefghijklmnopqrstu😀", "é".repeat(13), "😀😀😀😀😀😀😀"];
  return {
    description: "UTF-8 truncation for p and l: over 24 bytes becomes at most 21 bytes on a character boundary plus U+2026 (3 bytes).",
    cases: inputs.map((input) => ({ input, input_bytes: bytes(input), output: truncate(input), output_bytes: bytes(truncate(input)) })),
  };
}

function topic(m, a, t) {
  const input = `yaran-topic-v1\n${m}\n${a}\n${t ?? ""}`;
  return { m, a, t: t ?? null, digest_input_utf8: input, topic: createHash("sha256").update(input).digest("base64url").slice(0, 32) };
}

function topics() {
  return {
    description: "topic(m, a, t) = first 32 chars of base64url(SHA-256(\"yaran-topic-v1\\n\" + m + \"\\n\" + a + \"\\n\" + (t or \"\"))); delivery is the per-kind Web Push table with push.ttl_seconds = 3600.",
    topics: [topic(M, A, null), topic(M, A, T), topic(M, "x".repeat(128), null)],
    ttl_setting: 3600,
    delivery: [
      { k: "attention_raised", urgency: "high", ttl: 3600, topic: true, visible: true },
      { k: "attention_cleared", urgency: "very-low", ttl: 3600, topic: true, visible: false },
      { k: "agent_exited_badly", urgency: "high", ttl: 3600, topic: true, visible: true },
      { k: "test", urgency: "normal", ttl: 300, topic: false, visible: true },
    ],
  };
}

function parse() {
  const ok = (name, value) => ({ name, utf8: JSON.stringify(value), expect: "ok" });
  const bad = (name, utf8) => ({ name, utf8, expect: "push_payload_invalid" });
  const base = { v: 1, k: "attention_raised", m: M, a: A, s: "needs_attention", ts: 1731571200 };
  const padded = { ...base, l: "x".repeat(24), p: "y".repeat(24), t: "z".repeat(128) };
  return {
    description: "Device-side parse of decrypted push bytes. Any failure is push_payload_invalid and the generic notification stays.",
    cases: [
      ok("attention raised", base),
      ok("test", { v: 1, k: "test", ts: 1731571200 }),
      ok("unknown s token is accepted (worded generically)", { ...base, s: "brand_new_state" }),
      ok("unknown extra field is ignored", { ...base, z: 1 }),
      bad("test carrying m", JSON.stringify({ v: 1, k: "test", ts: 1, m: M })),
      bad("unknown k", JSON.stringify({ ...base, k: "brand_new_kind" })),
      bad("missing a", JSON.stringify({ v: 1, k: "attention_raised", m: M, s: "needs_attention", ts: 1 })),
      bad("v is 2", JSON.stringify({ ...base, v: 2 })),
      bad("l over 24 bytes in 9 characters", JSON.stringify({ ...base, l: "日本語のラベルです" })),
      bad("not JSON", "{\"v\":1,"),
      bad("over 320 bytes", JSON.stringify({ ...padded, a: "a".repeat(128) })),
    ],
  };
}

function relay() {
  const body = Buffer.from(Array.from({ length: 140 }, (_, i) => (i * 37 + 11) & 0xff)).toString("base64url");
  const r = "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f";
  const t = topic(M, A, T).topic;
  const appId = "com.example.yaran";
  const now = 1731571200;
  const fields = { v: 1, r, y: body };
  const alert = (thread) => ({ aps: { alert: { "title-loc-key": "PUSH_GENERIC_TITLE", "loc-key": "PUSH_GENERIC_BODY" }, "mutable-content": 1, sound: "default", "thread-id": thread }, ...fields });
  const hdr = (type, prio, ttl, collapse) => ({ "apns-push-type": type, "apns-priority": prio, "apns-expiration": String(ttl === 0 ? 0 : now + ttl), "apns-topic": appId, ...(collapse ? { "apns-collapse-id": collapse } : {}) });
  return {
    description: "How the relay wraps one aes128gcm body (y) for APNs and for FCM (G5 fallback). Inputs: urgency, topic, ttl, registration id, app id, now.",
    registration_id: r,
    body_b64url: body,
    app_id: appId,
    now,
    apns: [
      { name: "high alert", urgency: "high", topic: t, ttl: 3600, headers: hdr("alert", "10", 3600, t), payload: alert(t) },
      { name: "normal alert", urgency: "normal", topic: t, ttl: 3600, headers: hdr("alert", "5", 3600, t), payload: alert(t) },
      { name: "test alert has no topic", urgency: "normal", topic: null, ttl: 300, headers: hdr("alert", "5", 300, null), payload: alert("yaran") },
      { name: "low background", urgency: "low", topic: t, ttl: 3600, headers: hdr("background", "5", 3600, t), payload: { aps: { "content-available": 1 }, ...fields } },
      { name: "very-low background", urgency: "very-low", topic: t, ttl: 3600, headers: hdr("background", "5", 3600, t), payload: { aps: { "content-available": 1 }, ...fields } },
      { name: "ttl 0 stays 0", urgency: "high", topic: t, ttl: 0, headers: hdr("alert", "10", 0, t), payload: alert(t) },
    ],
    fcm: [
      { name: "high", urgency: "high", topic: t, ttl: 3600, message: { data: { v: "1", r, y: body }, android: { priority: "high", ttl: "3600s", collapse_key: t } } },
      { name: "very-low", urgency: "very-low", topic: t, ttl: 3600, message: { data: { v: "1", r, y: body }, android: { priority: "normal", ttl: "3600s", collapse_key: t } } },
      { name: "test", urgency: "normal", topic: null, ttl: 300, message: { data: { v: "1", r, y: body }, android: { priority: "normal", ttl: "300s" } } },
    ],
  };
}

export async function generate() {
  return {
    "push/payload-events.json": events(),
    "push/payload-truncation.json": truncation(),
    "push/payload-topic.json": topics(),
    "push/payload-parse.json": parse(),
    "push/relay-wrapping.json": relay(),
  };
}
