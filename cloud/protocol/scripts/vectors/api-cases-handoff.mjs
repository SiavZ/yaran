/**
 * API fixture cases for the handoff, push and relay schemas.
 *
 * Valid values plus one-change invalid values naming the failing JSON Schema keyword,
 * including the D24 requirements (HandoffQuery needs dk/dts/dsig, HandoffConsent needs
 * dk and refuses dts/dsig) and the push `test` shape rule.
 *
 * - Data only; deterministic.
 *
 * <module-headers:begin>
 * Uses:
 * scripts/vectors/api-cases-handoff.mjs
 * └── scripts/vectors/api-values.mjs
 * External: none
 *
 * Used by:
 * scripts/vectors/api-cases-handoff.mjs
 * └── scripts/vectors/api.mjs
 * <module-headers:end>
 */
import { CSRF, DEL, DK, DSIG, E, EMAIL, HOST, JWT, m, PK, point, STATE, T, U1, U2, U3, VAPID } from "./api-values.mjs";

const H = "handoff.schema.json";
const RELEASE = "https://app.example.com/auth/callback";
const query = { v: 1, pk: PK, state: STATE, redirect: RELEASE, device: "Ada's Pixel", dk: DK, dts: "1731571200", dsig: DSIG };
const consent = { v: 1, pk: PK, state: STATE, redirect: RELEASE, device: "Ada's Pixel", dk: DK, csrf: CSRF, decision: "continue" };
const epk = Buffer.from(point("epk"), "base64url");
const header = {
  alg: "ECDH-ES", enc: "A256GCM", typ: "yaran-handoff+jwe", cty: "yaran-handoff+json", kid: "NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs",
  epk: { kty: "EC", crv: "P-256", x: epk.subarray(1, 33).toString("base64url"), y: epk.subarray(33).toString("base64url") },
  apu: Buffer.from(HOST).toString("base64url"), apv: Buffer.from(STATE).toString("base64url"),
};
const payload = { v: 1, kind: "machine", host: HOST, jwt: JWT, email: EMAIL, exp: 1731657600, iat: 1731571200 };
const jwe = "eyJhbGciOiJFQ0RILUVTIn0..AAAAAAAAAAAAAAAA.Y2lwaGVy.dGFnMDEyMzQ1Njc4OWFi";

const handoff = [
  T("HandoffState", H, [["22 chars", STATE.slice(0, 22)]], [["129 chars", "pattern", "s".repeat(129)], ["plus", "pattern", `${STATE}+`]]),
  E("HandoffBuild", H, ["release", "dev"]),
  E("HandoffMode", H, ["query", "fragment"]),
  T("HandoffQuery", H, [["release", query], ["dev fragment", m(query, { redirect: "yaranapp://auth/callback", build: "dev", mode: "fragment" })]], [
    ["missing dk", "required", m(query, { dk: DEL })], ["missing dts", "required", m(query, { dts: DEL })], ["missing dsig", "required", m(query, { dsig: DEL })],
    ["compressed pk", "pattern", m(query, { pk: `A${PK.slice(1)}` })], ["short state", "pattern", m(query, { state: "short" })],
    ["257-char redirect", "maxLength", m(query, { redirect: `https://app.example.com/${"a".repeat(233)}` })],
    ["unknown build", "enum", m(query, { build: "debug" })], ["unknown mode", "enum", m(query, { mode: "form_post" })],
    ["empty device", "minLength", m(query, { device: "" })], ["65-char device", "maxLength", m(query, { device: "d".repeat(65) })],
    ["leading-zero dts", "pattern", m(query, { dts: "01731571200" })], ["13-digit dts", "pattern", m(query, { dts: "1731571200000" })],
    ["85-char dsig", "pattern", m(query, { dsig: DSIG.slice(0, 85) })], ["unknown field", "additionalProperties", m(query, { extra: "x" })],
    ["v zero", "minimum", m(query, { v: 0 })],
  ]),
  T("HandoffConsent", H, [["continue", consent], ["cancel", m(consent, { decision: "cancel", build: "release", mode: "query" })]], [
    ["missing dk", "required", m(consent, { dk: DEL })], ["unknown decision", "enum", m(consent, { decision: "approve" })],
    ["short csrf", "pattern", m(consent, { csrf: "abc" })], ["re-sent dts", "additionalProperties", m(consent, { dts: "1731571200" })],
    ["missing csrf", "required", m(consent, { csrf: DEL })],
  ]),
  T("HandoffProtectedHeader", H, [["profile", header]], [
    ["rsa alg", "const", m(header, { alg: "RSA-OAEP" })], ["a128gcm", "const", m(header, { enc: "A128GCM" })],
    ["other typ", "const", m(header, { typ: "JWE" })], ["other cty", "const", m(header, { cty: "JWT" })],
    ["42-char kid", "pattern", m(header, { kid: header.kid.slice(1) })], ["other curve", "const", m(header, { "epk.crv": "P-384" })],
    ["42-char x", "pattern", m(header, { "epk.x": header.epk.x.slice(1) })], ["missing apu", "required", m(header, { apu: DEL })],
    ["padded apv", "pattern", m(header, { apv: `${header.apv}=` })],
  ]),
  T("HandoffPayload", H, [["machine", payload], ["control plane with cookie", m(payload, { kind: "control_plane", host: "cp.example.com", cookie: JWT })]], [
    ["v2", "const", m(payload, { v: 2 })], ["unknown kind", "enum", m(payload, { kind: "phone" })], ["uppercase host", "pattern", m(payload, { host: "Laptop.example.com" })],
    ["not a jwt", "pattern", m(payload, { jwt: "notajwt" })], ["bad email", "format", m(payload, { email: "ada" })],
    ["negative exp", "minimum", m(payload, { exp: -1 })], ["string iat", "type", m(payload, { iat: "1" })],
    ["empty cookie", "minLength", m(payload, { cookie: "" })], ["unknown field", "additionalProperties", m(payload, { aud: "x" })],
    ["missing email", "required", m(payload, { email: DEL })],
  ]),
  T("HandoffCallback", H, [
    ["success", { state: STATE, jwe }], ["declined", { state: STATE, error: "handoff_declined" }],
    ["protocol range", { state: STATE, error: "protocol_unsupported", min: "1", max: "1" }],
    ["skewed", { state: STATE, error: "handoff_timestamp_skewed", server_time: "1731571200" }],
  ], [
    ["jwe and error", "oneOf", { state: STATE, jwe, error: "handoff_declined" }],
    ["four-part jwe", "oneOf", { state: STATE, jwe: "a..b.c" }], ["missing state", "oneOf", { jwe }],
  ]),
];

const PU = "push.schema.json";
const raised = { v: 1, k: "attention_raised", m: U1, a: U2, t: U3, s: "needs_attention", p: "yaran", l: "fix the flaky test", ts: 1731571200 };
const push = [
  E("PushKind", PU, ["attention_raised", "attention_cleared", "agent_exited_badly", "test"]),
  T("PushPayload", PU, [
    ["attention", raised], ["slot tab, minimal detail", m(raised, { t: DEL, p: DEL, l: DEL })],
    ["exit", m(raised, { k: "agent_exited_badly", s: "rapid_clean_exit" })], ["test", { v: 1, k: "test", ts: 1731571200 }],
  ], [
    ["test with m", "propertyNames", { v: 1, k: "test", ts: 1731571200, m: U1 }], ["v2", "const", m(raised, { v: 2 })],
    ["unknown kind", "enum", m(raised, { k: "poke" })], ["attention without a", "required", m(raised, { a: DEL })],
    ["display text s", "pattern", m(raised, { s: "Needs you" })], ["25-char p", "maxLength", m(raised, { p: "p".repeat(25) })],
    ["empty l", "minLength", m(raised, { l: "" })], ["negative ts", "minimum", m(raised, { ts: -1 })],
    ["uppercase m", "pattern", m(raised, { m: U1.toUpperCase() })], ["missing ts", "required", m(raised, { ts: DEL })],
  ]),
];

const R = "relay.schema.json";
const relayMeta = { service: "yaran-push-relay", protocol: { min: 1, max: 1 }, apps: ["com.example.yaran"], channels: ["apns"], endpoint_key_id: "k1" };
const apns = {
  kind: "apns", app_id: "com.example.yaran", apns_token: "ab".repeat(32), apns_environment: "production", vapid_public_key: VAPID, registration_id: U1,
};
const fcm = { kind: "fcm", app_id: "com.example.yaran", fcm_token: "fcm-token:APA91b", vapid_public_key: VAPID, registration_id: U1 };
const fields = { v: 1, r: U1, y: "8pfeW0KbunFT06SuDKoJH9Ql87S1QUrd" };
const alert = {
  aps: { alert: { "title-loc-key": "PUSH_GENERIC_TITLE", "loc-key": "PUSH_GENERIC_BODY" }, "mutable-content": 1, sound: "default", "thread-id": "abcdefghijklmnopqrstuvwxyz012345" },
  ...fields,
};
const background = { aps: { "content-available": 1 }, ...fields };
const fcmMessage = { data: { v: "1", r: U1, y: fields.y }, android: { priority: "high", ttl: "3600s", collapse_key: "abcdefghijklmnopqrstuvwxyz012345" } };

const relay = [
  T("RelayMeta", R, [["apns only", relayMeta], ["with fcm", m(relayMeta, { channels: ["apns", "fcm"] })]], [
    ["other service", "const", m(relayMeta, { service: "yaran-cloud" })], ["unknown channel", "enum", m(relayMeta, { channels: ["webpush"] })],
    ["17-char kid", "pattern", m(relayMeta, { endpoint_key_id: "k".repeat(17) })], ["missing apps", "required", m(relayMeta, { apps: DEL })],
  ]),
  T("EndpointMintRequest", R, [["apns", apns], ["fcm", fcm]], [
    ["unknown kind", "oneOf", m(apns, { kind: "webpush" })], ["apns with fcm token", "oneOf", m(apns, { fcm_token: "x" })],
  ]),
  T("ApnsMintRequest", R, [["production", apns], ["sandbox", m(apns, { apns_environment: "sandbox" })]], [
    ["uppercase token", "pattern", m(apns, { apns_token: "AB".repeat(32) })], ["63-char token", "pattern", m(apns, { apns_token: "a".repeat(63) })],
    ["unknown environment", "enum", m(apns, { apns_environment: "staging" })], ["156-char app id", "maxLength", m(apns, { app_id: "a".repeat(156) })],
    ["unknown field", "additionalProperties", m(apns, { extra: 1 })], ["missing registration_id", "required", m(apns, { registration_id: DEL })],
    ["fcm kind", "const", m(apns, { kind: "fcm" })],
  ]),
  T("FcmMintRequest", R, [["fcm", fcm]], [
    ["empty token", "minLength", m(fcm, { fcm_token: "" })], ["unknown field", "additionalProperties", m(fcm, { apns_token: "ab" })],
    ["apns kind", "const", m(fcm, { kind: "apns" })],
  ]),
  T("EndpointMintResponse", R, [["endpoint", { endpoint: "https://relay.example.com/w/v1.k1.abcdefghijklmnop_-" }]], [
    ["http", "pattern", { endpoint: "http://relay.example.com/w/v1.k1.abcdefghijklmnop" }],
    ["17-char kid", "pattern", { endpoint: `https://relay.example.com/w/v1.${"k".repeat(17)}.abcdefghijklmnop` }],
    ["15-char opaque", "pattern", { endpoint: "https://relay.example.com/w/v1.k1.abcdefghijklmno" }], ["missing", "required", {}],
  ]),
  T("RelayFields", R, [["fields", fields]], [
    ["v2", "const", m(fields, { v: 2 })], ["empty y", "minLength", m(fields, { y: "" })], ["padded y", "pattern", m(fields, { y: "abc=" })],
    ["missing r", "required", m(fields, { r: DEL })],
  ]),
  T("RelayApnsAlert", R, [["topic thread", alert], ["test thread", m(alert, { "aps.thread-id": "yaran" })]], [
    ["other loc key", "const", m(alert, { "aps.alert.loc-key": "BODY" })], ["mutable-content 0", "const", m(alert, { "aps.mutable-content": 0 })],
    ["short thread id", "pattern", m(alert, { "aps.thread-id": "abc" })], ["unknown aps field", "additionalProperties", m(alert, { "aps.badge": 1 })],
    ["missing y", "required", m(alert, { y: DEL })], ["missing aps", "required", m(alert, { aps: DEL })],
  ]),
  T("RelayApnsBackground", R, [["background", background]], [
    ["content-available 0", "const", m(background, { "aps.content-available": 0 })], ["unknown aps field", "additionalProperties", m(background, { "aps.sound": "default" })],
    ["missing r", "required", m(background, { r: DEL })],
  ]),
  T("RelayFcmMessage", R, [["high", fcmMessage], ["normal without collapse", m(fcmMessage, { "android.priority": "normal", "android.collapse_key": DEL })]], [
    ["numeric v", "const", m(fcmMessage, { "data.v": 1 })], ["unknown priority", "enum", m(fcmMessage, { "android.priority": "max" })],
    ["ttl without unit", "pattern", m(fcmMessage, { "android.ttl": "3600" })], ["31-char collapse key", "pattern", m(fcmMessage, { "android.collapse_key": "a".repeat(31) })],
    ["unknown data field", "additionalProperties", m(fcmMessage, { "data.extra": "x" })], ["missing android", "required", m(fcmMessage, { android: DEL })],
  ]),
];

export const cases = [...handoff, ...push, ...relay];
