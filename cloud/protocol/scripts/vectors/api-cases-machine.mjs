/**
 * API fixture cases for the machine, me and devices schemas.
 *
 * Valid values plus one-change invalid values naming the failing JSON Schema keyword.
 * The machine types here are the ones yaran's Rust module round-trips, so every valid
 * value carries only schema-defined keys.
 *
 * - Data only; deterministic.
 *
 * <module-headers:begin>
 * Uses:
 * scripts/vectors/api-cases-machine.mjs
 * └── scripts/vectors/api-values.mjs
 * External: none
 *
 * Used by:
 * scripts/vectors/api-cases-machine.mjs
 * ├── scripts/vectors/api-cases-admin.mjs
 * └── scripts/vectors/api.mjs
 * <module-headers:end>
 */
import { AUD, B43, CP, DEL, DK, E, EMAIL, FP, HOST, m, point, T, TEAM, TS, TS2, U1, U2, U3, VAPID, VERIFIER } from "./api-values.mjs";

const M = "machine.schema.json";
const tunnel = { id: U2, token: "eyJhIjoiYWNjb3VudCIsInQiOiJ0dW5uZWwifQ", token_version: 1 };
const access = { team_domain: TEAM, aud: AUD };
const claimReq = { code: B43, code_verifier: VERIFIER, yaran_version: "0.42.0", origin_port: 3890 };
const claimRes = {
  machine_id: U1, machine_name: "laptop", hostname: HOST, url: `https://${HOST}`, origin_port: 3890, tunnel, access,
  owner_email: EMAIL, user_slug: "ada", org: { name: "Example Org", url: CP }, protocol: 1,
};
const config = {
  machine_id: U1, hostname: HOST, url: `https://${HOST}`, origin_port: 3890, access, tunnel: { id: U2, token_version: 1 },
  owner_email: EMAIL, push: { enabled: true, detail: "names" }, events: { max_batch: 16, min_interval_ms: 1000 }, server_time: TS,
};
const raised = {
  id: U3, kind: "attention_raised", ts: TS, agent_id: U1, tab_id: U2, state: "needs_attention", project: "yaran", label: "fix the flaky test",
};
const cleared = { id: U2, kind: "attention_cleared", ts: TS2, agent_id: U1, state: "idle" };
const exited = { id: U1, kind: "agent_exited_badly", ts: TS, agent_id: U1, ending: "exited", exit_status: 1, project: "yaran", label: "agent" };

/** n distinct v4 uuids for batches. */
const uuid = (i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
const batchOf = (n) => ({ events: Array.from({ length: n }, (_, i) => m(cleared, { id: uuid(i) })) });

const machine = [
  T("TunnelCredentials", M, [["credentials", tunnel]], [
    ["empty token", "minLength", m(tunnel, { token: "" })], ["4097-char token", "maxLength", m(tunnel, { token: "t".repeat(4097) })],
    ["version zero", "minimum", m(tunnel, { token_version: 0 })], ["bad id", "pattern", m(tunnel, { id: "tunnel" })],
    ["missing token", "required", m(tunnel, { token: DEL })],
  ]),
  T("MachineAccess", M, [["access", access]], [
    ["63-char aud", "pattern", m(access, { aud: AUD.slice(1) })], ["uppercase aud", "pattern", m(access, { aud: AUD.toUpperCase() })],
    ["missing aud", "required", m(access, { aud: DEL })],
  ]),
  T("ClaimRequest", M, [["claim", claimReq]], [
    ["unknown field", "additionalProperties", m(claimReq, { extra: true })], ["missing origin_port", "required", m(claimReq, { origin_port: DEL })],
    ["42-char verifier", "pattern", m(claimReq, { code_verifier: VERIFIER.slice(0, 42) })],
    ["plus in verifier", "pattern", m(claimReq, { code_verifier: `${VERIFIER}+` })],
    ["port too big", "maximum", m(claimReq, { origin_port: 70000 })], ["empty version", "minLength", m(claimReq, { yaran_version: "" })],
  ]),
  T("ClaimResponse", M, [["claim", claimRes]], [
    ["missing owner_email", "required", m(claimRes, { owner_email: DEL })], ["http url", "pattern", m(claimRes, { url: `http://${HOST}` })],
    ["31-char slug", "pattern", m(claimRes, { user_slug: "a".repeat(31) })], ["protocol zero", "minimum", m(claimRes, { protocol: 0 })],
    ["bad email", "format", m(claimRes, { owner_email: "ada.example.org" })], ["tunnel without token", "required", m(claimRes, { "tunnel.token": DEL })],
  ]),
  T("MachineConfig", M, [["config", config], ["minimal push", m(config, { push: { enabled: false, detail: "minimal" } })]], [
    ["batch 17", "maximum", m(config, { "events.max_batch": 17 })], ["negative interval", "minimum", m(config, { "events.min_interval_ms": -1 })],
    ["unknown detail", "enum", m(config, { "push.detail": "full" })], ["fractional server time", "pattern", m(config, { server_time: "2026-11-14T12:00:00.5Z" })],
    ["token version zero", "minimum", m(config, { "tunnel.token_version": 0 })], ["missing server_time", "required", m(config, { server_time: DEL })],
  ]),
  T("EventBatch", M, [["one event", { events: [raised] }], ["16 events", batchOf(16)], ["mixed", { events: [raised, cleared, exited] }]], [
    ["empty", "minItems", { events: [] }], ["17 events", "maxItems", batchOf(17)],
    ["unknown field", "additionalProperties", { events: [raised], extra: 1 }], ["bad event", "oneOf", { events: [m(raised, { kind: "poked" })] }],
  ]),
  T("Event", M, [["attention arm", raised], ["exit arm", exited]], [
    ["unknown kind", "oneOf", m(raised, { kind: "poked" })], ["attention with ending", "oneOf", m(cleared, { ending: "exited" })],
  ]),
  T("AttentionEvent", M, [["raised", raised], ["cleared slot tab", cleared]], [
    ["raised with idle", "const", m(raised, { state: "idle" })], ["unknown field", "additionalProperties", m(cleared, { ending: "exited" })],
    ["unknown state", "enum", m(cleared, { state: "sleeping" })], ["65-char project", "maxLength", m(raised, { project: "p".repeat(65) })],
    ["empty agent id", "pattern", m(raised, { agent_id: "" })], ["missing ts", "required", m(raised, { ts: DEL })],
    ["offset ts", "pattern", m(raised, { ts: "2026-11-14T12:00:00+00:00" })],
  ]),
  T("ExitEvent", M, [["with status", exited], ["without status", m(exited, { exit_status: DEL, project: DEL, label: DEL })]], [
    ["attention kind", "const", m(exited, { kind: "attention_raised" })], ["unknown ending", "enum", m(exited, { ending: "crashed" })],
    ["fractional status", "type", m(exited, { exit_status: 1.5 })], ["missing ending", "required", m(exited, { ending: DEL })],
  ]),
  T("EventBatchResult", M, [["result", { accepted: [U1], duplicates: [], push_enabled: true }]], [
    ["missing push_enabled", "required", { accepted: [], duplicates: [] }],
    ["bad id", "pattern", { accepted: ["x"], duplicates: [], push_enabled: true }],
    ["object duplicates", "type", { accepted: [], duplicates: {}, push_enabled: true }],
  ]),
  T("RotateRequest", M, [["user", { known_token_version: 1, reason: "user" }], ["sync", { known_token_version: 3, reason: "sync" }]], [
    ["unknown reason", "enum", { known_token_version: 1, reason: "force" }],
    ["unknown field", "additionalProperties", { known_token_version: 1, reason: "user", extra: 1 }],
    ["version zero", "minimum", { known_token_version: 0, reason: "user" }],
  ]),
  T("RotateResponse", M, [["rotated", { tunnel, rotated: true }]], [
    ["missing rotated", "required", { tunnel }], ["token version zero", "minimum", { tunnel: m(tunnel, { token_version: 0 }), rotated: false }],
  ]),
  T("TeardownStarted", M, [["teardown", { machine_id: U1, state: "tearing_down" }]], [
    ["other state", "const", { machine_id: U1, state: "deleted" }], ["missing machine_id", "required", { state: "tearing_down" }],
  ]),
  T("OriginUpdate", M, [["port", { origin_port: 3891 }]], [
    ["port zero", "minimum", { origin_port: 0 }], ["unknown field", "additionalProperties", { origin_port: 1, extra: 1 }], ["empty", "required", {}],
  ]),
  T("OriginUpdateResult", M, [["changed", { origin_port: 3891, changed: true }]], [
    ["string changed", "type", { origin_port: 3891, changed: "yes" }], ["missing changed", "required", { origin_port: 3891 }],
  ]),
];

const ME = "me.schema.json";
const counts = { machines: 2, devices: 1 };
const me = {
  email: EMAIL, role: "user", user_slug: "ada", org: { name: "Example Org", url: CP }, limits: { machines: 10, devices: 10 }, counts, session_exp: TS2,
};
export const summary = {
  id: U1, name: "laptop", hostname: HOST, url: `https://${HOST}`, status: "online", status_checked_at: TS, paired_at: TS,
};
const summaryFull = m(summary, { reported_protocol: 1, last_seen_at: TS2, yaran_version: "0.42.0" });

const meTypes = [
  T("Me", ME, [["user", me], ["admin", m(me, { role: "admin" })]], [
    ["unknown role", "enum", m(me, { role: "owner" })], ["limits without devices", "required", m(me, { "limits.devices": DEL })],
    ["negative count", "minimum", m(me, { "counts.machines": -1 })], ["bad session_exp", "pattern", m(me, { session_exp: "tomorrow" })],
    ["missing org", "required", m(me, { org: DEL })],
  ]),
  T("UserCounts", ME, [["counts", counts]], [
    ["negative", "minimum", { machines: -1, devices: 0 }], ["missing devices", "required", { machines: 1 }], ["string", "type", { machines: "1", devices: 0 }],
  ]),
  E("MachineStatus", ME, ["online", "degraded", "offline", "never_connected", "provisioning", "tearing_down", "unknown"]),
  T("MachineSummary", ME, [
    ["required only", summary], ["every field", summaryFull],
    ["nulls", m(summary, { reported_protocol: null, last_seen_at: null, yaran_version: null })],
  ], [
    ["unknown status", "enum", m(summary, { status: "broken" })], ["protocol zero", "oneOf", m(summary, { reported_protocol: 0 })],
    ["bad last_seen_at", "oneOf", m(summary, { last_seen_at: "never" })], ["http url", "pattern", m(summary, { url: `http://${HOST}` })],
    ["uppercase name", "pattern", m(summary, { name: "Laptop" })], ["missing paired_at", "required", m(summary, { paired_at: DEL })],
    ["41-char version", "oneOf", m(summary, { yaran_version: "1".repeat(41) })],
  ]),
  T("MachinePage", ME, [["last page", { items: [summary], next_cursor: null }], ["more", { items: [summaryFull], next_cursor: "abc" }]], [
    ["missing next_cursor", "required", { items: [] }], ["bad cursor", "oneOf", { items: [], next_cursor: "a/b" }],
    ["object items", "type", { items: {}, next_cursor: null }],
  ]),
];

const D = "devices.schema.json";
const webpush = {
  kind: "webpush", channel: "unifiedpush", distributor: "io.heckel.ntfy", endpoint: "https://push.example.org/up/abc",
  keys: { p256dh: point("ua-key"), auth: "BTBZMqHH6r4Tts7J_aSIgg" },
};
const registration = {
  install_id: U2, device_key: DK, platform: "android", flavor: "foss", form_factor: "phone", app_version: "1.0.0", label: "Ada's Pixel",
  push: webpush, mute_all: false, muted_until: null, muted_machine_ids: [],
};
export const device = {
  id: U3, install_id: U2, device_key_fingerprint: FP, platform: "ios", flavor: "appstore", form_factor: "tablet", app_version: "1.0.0",
  label: "Ada's iPad", push: { kind: "webpush", channel: "apns_relay", endpoint_host: "relay.example.com", last_success_at: TS,
    last_error_code: null, vapid_public_key: VAPID },
  push_state: "active", mute_all: false, muted_until: null, muted_machine_ids: [U1], created_at: TS, last_seen_at: TS2, current: true,
};

const devices = [
  T("MutedMachineIds", D, [["empty", []], ["two", [U1, U2]]], [
    ["duplicate", "uniqueItems", [U1, U1]], ["101 ids", "maxItems", Array.from({ length: 101 }, (_, i) => uuid(i))], ["bad id", "pattern", ["x"]],
  ]),
  T("DeviceLabel", D, [["label", "Ada's Pixel"]], [["empty", "minLength", ""], ["65 chars", "maxLength", "l".repeat(65)]]),
  T("PushNone", D, [["none", { kind: "none" }]], [
    ["webpush kind", "const", { kind: "webpush" }], ["unknown field", "additionalProperties", { kind: "none", extra: 1 }], ["missing kind", "required", {}],
  ]),
  T("PushWebpush", D, [["unifiedpush", webpush], ["relay without distributor", m(webpush, { channel: "apns_relay", distributor: DEL })]], [
    ["http endpoint", "pattern", m(webpush, { endpoint: "http://push.example.org/x" })],
    ["2049-char endpoint", "maxLength", m(webpush, { endpoint: `https://push.example.org/${"a".repeat(2025)}` })],
    ["21-char auth", "pattern", m(webpush, { "keys.auth": "BTBZMqHH6r4Tts7J_aSIg" })],
    ["unknown key field", "additionalProperties", m(webpush, { "keys.extra": "x" })], ["unknown channel", "enum", m(webpush, { channel: "sms" })],
    ["missing keys", "required", m(webpush, { keys: DEL })], ["bad p256dh", "pattern", m(webpush, { "keys.p256dh": "abc" })],
  ]),
  T("DeviceRegistration", D, [
    ["webpush", registration],
    ["no push, locale, timed mute", m(registration, { push: { kind: "none" }, locale: "en-GB", muted_until: TS2, muted_machine_ids: [U1] })],
  ], [
    ["missing device_key", "required", m(registration, { device_key: DEL })], ["uppercase install id", "pattern", m(registration, { install_id: U2.toUpperCase() })],
    ["unknown platform", "enum", m(registration, { platform: "windows" })], ["unknown flavor", "enum", m(registration, { flavor: "beta" })],
    ["unknown form factor", "enum", m(registration, { form_factor: "watch" })], ["bad app version", "pattern", m(registration, { app_version: "1.0" })],
    ["empty label", "minLength", m(registration, { label: "" })], ["bad locale", "pattern", m(registration, { locale: "english" })],
    ["webpush without fields", "oneOf", m(registration, { push: { kind: "webpush" } })], ["string mute_all", "type", m(registration, { mute_all: "no" })],
    ["bad muted_until", "oneOf", m(registration, { muted_until: "later" })], ["duplicate muted ids", "uniqueItems", m(registration, { muted_machine_ids: [U1, U1] })],
    ["unknown field", "additionalProperties", m(registration, { extra: 1 })], ["compressed device key", "pattern", m(registration, { device_key: `A${DK.slice(1)}` })],
  ]),
  T("DevicePatch", D, [["label", { label: "New name" }], ["mute", { mute_all: true }], ["clear timed mute", { muted_until: null }], ["clear machine mutes", { muted_machine_ids: [] }]], [
    ["empty", "minProperties", {}], ["unknown field", "additionalProperties", { extra: 1 }], ["empty label", "minLength", { label: "" }],
  ]),
  E("PushState", D, ["active", "gone", "auth_failed", "failing", "none"]),
  T("DevicePush", D, [["none", { kind: "none" }], ["webpush", device.push]], [
    ["unknown kind", "enum", { kind: "sms" }], ["uppercase host", "pattern", m(device.push, { endpoint_host: "Relay.example.com" })], ["missing kind", "required", {}],
  ]),
  T("Device", D, [["device", device], ["no push", m(device, { push: { kind: "none" }, push_state: "none", muted_machine_ids: [], current: false })]], [
    ["missing device_key_fingerprint", "required", m(device, { device_key_fingerprint: DEL })],
    ["bad fingerprint", "pattern", m(device, { device_key_fingerprint: "abc" })], ["unknown push_state", "enum", m(device, { push_state: "dead" })],
    ["string current", "type", m(device, { current: "yes" })], ["bad created_at", "pattern", m(device, { created_at: "2026-11-14" })],
    ["push without kind", "required", m(device, { push: {} })],
  ]),
  T("DevicePage", D, [["page", { items: [device], next_cursor: null }]], [["item missing id", "required", { items: [m(device, { id: DEL })], next_cursor: null }]]),
];

export const cases = [...machine, ...meTypes, ...devices];
