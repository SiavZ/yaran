/**
 * API fixture cases for common, meta, pairing, error and release-manifest schemas.
 *
 * Each entry lists valid values and one-change invalid values naming the JSON Schema
 * keyword that fails, so every suite (TS schema test, Rust round-trip, Worker, relay)
 * agrees on what each schema accepts.
 *
 * - Data only; deterministic.
 *
 * <module-headers:begin>
 * Uses:
 * scripts/vectors/api-cases-common.mjs
 * └── scripts/vectors/api-values.mjs
 * External: (none)
 *
 * Used by:
 * scripts/vectors/api-cases-common.mjs
 * └── scripts/vectors/api.mjs
 * <module-headers:end>
 */
import { AUD, B43, CP, CSRF, DEL, DSIG, E, ed25519, FP, HOST, m, MACHINE_PUB, PK, STATE, T, TEAM, TS, U1, U2, VAPID } from "./api-values.mjs";

const C = "common.schema.json";
const pattern = (pairs) => pairs.map(([name, value]) => [name, "pattern", value]);

const common = [
  T("Uuid", C, [["v4", U1]], [...pattern([["uppercase", U1.toUpperCase()], ["version 1", "3f1c2b4a-5d6e-1f70-8a9b-0c1d2e3f4a5b"]]), ["number", "type", 1]]),
  T("YaranId", C, [["uuid", U1], ["printable ascii", "agent:1"]], [
    ...pattern([["empty", ""], ["space", "a b"], ["129 chars", "a".repeat(129)], ["non-ascii", "agént"]]),
    ["number", "type", 7],
  ]),
  T("Timestamp", C, [["utc seconds", TS]], [
    ...pattern([["fractional seconds", "2026-11-14T12:00:00.123Z"], ["offset", "2026-11-14T12:00:00+01:00"], ["date only", "2026-11-14"]]),
    ["month 13", "format", "2026-13-14T12:00:00Z"],
  ]),
  T("B64url", C, [["alphabet", "abc_-XYZ09"], ["empty", ""]], pattern([["plus", "a+b"], ["padding", "abcd=="]])),
  T("P256Point", C, [["real point", PK]], pattern([["86 chars", PK.slice(0, 86)], ["compressed prefix", `A${PK.slice(1)}`], ["standard base64", `${PK.slice(0, 86)}+`]])),
  T("Ed25519PublicKey", C, [["real key", MACHINE_PUB]], pattern([["44 chars", `${MACHINE_PUB}A`], ["non-canonical last char", `${MACHINE_PUB.slice(0, 42)}B`]])),
  T("Email", C, [["plain", "ada@example.org"]], [["no at sign", "format", "ada.example.org"], ["255 chars", "maxLength", `ada@${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(55)}.org`]]),
  T("OrgUrl", C, [["origin", CP], ["deep name", "https://yaran.cp.example.org"]], pattern([
    ["http", "http://cp.example.com"], ["trailing slash", "https://cp.example.com/"], ["port", "https://cp.example.com:8443"], ["uppercase", "https://CP.example.com"],
  ])),
  T("Hostname", C, [["machine host", HOST], ["single label", "localhost"]], [
    ...pattern([["uppercase", "Laptop.example.com"], ["leading hyphen", "-a.example.com"], ["empty label", "a..example.com"]]),
    ["254 chars", "maxLength", `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(62)}`],
  ]),
  T("MachineName", C, [["word", "laptop"], ["one char", "a"], ["32 chars", "a".repeat(32)]], pattern([["uppercase", "Laptop"], ["33 chars", "a".repeat(33)], ["leading hyphen", "-laptop"]])),
  T("UserSlug", C, [["slug", "ada"]], pattern([["31 chars", "a".repeat(31)], ["underscore", "ada_l"]])),
  T("SemVer", C, [["release", "1.2.3"], ["prerelease", "1.2.3-beta.1"]], pattern([["two parts", "1.2"], ["v prefix", "v1.2.3"], ["five digits", "12345.0.0"]])),
  T("OriginPort", C, [["default", 3890], ["min", 1], ["max", 65535]], [
    ["zero", "minimum", 0], ["too big", "maximum", 65536], ["fraction", "type", 3890.5], ["string", "type", "3890"],
  ]),
  T("MachineKeyFingerprint", C, [["display", FP]], pattern([["lowercase", FP.toLowerCase()], ["digit 0", "K7QF-3MZD-W2PA-HX5R-LC4N-TB60"], ["no dashes", FP.replaceAll("-", "")]])),
  T("DeviceKeyFingerprint", C, [["display", FP]], pattern([["lowercase", FP.toLowerCase()], ["five groups", FP.slice(0, 24)]])),
  T("EcdsaP256Sig", C, [["raw r||s", DSIG]], pattern([["85 chars", DSIG.slice(0, 85)], ["87 chars", `${DSIG}A`]])),
  T("RequestId", C, [["cf-ray", "8d1f2c3b4a5e6f70-LHR"]], pattern([["underscore", "a_b"], ["65 chars", "a".repeat(65)], ["empty", ""]])),
  T("InstallId", C, [["v4", U2]], pattern([["uppercase", U2.toUpperCase()]])),
  T("Cursor", C, [["token", "abc_-1"], ["empty", ""]], [["slash", "pattern", "a/b"], ["257 chars", "maxLength", "a".repeat(257)]]),
  T("ProtocolRange", C, [["one", { min: 1, max: 1 }], ["window", { min: 1, max: 2 }]], [
    ["missing max", "required", { min: 1 }], ["min zero", "minimum", { min: 0, max: 1 }], ["string min", "type", { min: "1", max: 1 }],
  ]),
  T("OrgRef", C, [["org", { name: "Example Org", url: CP }]], [
    ["missing url", "required", { name: "Example Org" }], ["empty name", "minLength", { name: "", url: CP }],
    ["81 char name", "maxLength", { name: "n".repeat(81), url: CP }], ["http url", "pattern", { name: "x", url: "http://cp.example.com" }],
  ]),
  T("NullableTimestamp", C, [["timestamp", TS], ["null", null]], [["bad string", "oneOf", "yesterday"]]),
  T("NullableString", C, [["string", "x"], ["null", null]], [["number", "oneOf", 1]]),
  T("NullableP256Point", C, [["point", VAPID], ["null", null]], [["short", "oneOf", "abc"]]),
  E("Platform", C, ["android", "ios"]),
  E("Flavor", C, ["foss", "play", "appstore", "dev"]),
  E("FormFactor", C, ["phone", "tablet"]),
  E("Role", C, ["user", "admin"]),
  E("PushChannel", C, ["unifiedpush", "fcm_embedded", "apns_relay", "fcm_relay"]),
  E("RowStateToken", C, ["needs_attention", "typing", "busy", "idle", "detached", "exited"]),
  E("EndingToken", C, ["launch_failed", "exited", "exited_unknown", "rapid_clean_exit"]),
];

const metaClosed = {
  service: "yaran-cloud",
  protocol: { min: 1, max: 1 },
  setup: "closed",
  worker: { version: "1.0.0" },
  org: { name: "Example Org", url: CP },
  access: { team_domain: TEAM },
  capabilities: ["pairing.v1", "handoff.v1", "push.webpush"],
  push: { enabled: true, vapid_public_key: VAPID },
};
const metaOpen = { service: "yaran-cloud", protocol: { min: 1, max: 1 }, setup: "open", worker: { version: "1.0.0" } };

const meta = [
  T("Meta", "meta.schema.json", [
    ["closed", metaClosed],
    ["open with only the required fields", metaOpen],
    ["closed, push off, with deprecations", m(metaClosed, { push: { enabled: false, vapid_public_key: null }, deprecations: [{ protocol: 1, after: "2027-11-14" }] })],
  ], [
    ["closed without org", "required", m(metaClosed, { org: DEL })],
    ["closed without push", "required", m(metaClosed, { push: DEL })],
    ["wrong service", "const", m(metaOpen, { service: "yaran" })],
    ["unknown setup", "enum", m(metaOpen, { setup: "pending" })],
    ["missing protocol", "required", m(metaOpen, { protocol: DEL })],
    ["bad worker version", "pattern", m(metaOpen, { "worker.version": "1" })],
    ["bad capability", "pattern", m(metaClosed, { capabilities: ["Pairing"] })],
    ["bad deprecation date", "format", m(metaOpen, { deprecations: [{ protocol: 1, after: "2027-13-01" }] })],
    ["uppercase team domain", "pattern", m(metaClosed, { "access.team_domain": "Team.example.com" })],
    ["push without key field", "required", m(metaClosed, { push: { enabled: true } })],
  ]),
  T("Deprecation", "meta.schema.json", [["entry", { protocol: 1, after: "2027-11-14" }]], [
    ["missing after", "required", { protocol: 1 }], ["protocol zero", "minimum", { protocol: 0, after: "2027-11-14" }],
    ["not a date", "format", { protocol: 1, after: "2027-02-30" }],
  ]),
];

const P = "pairing.schema.json";
const authorize = {
  v: 1, state: STATE, code_challenge: B43, code_challenge_method: "S256", machine_pubkey: MACHINE_PUB,
  machine_name: "laptop", callback: "http://127.0.0.1:53682/callback", yaran_version: "0.42.0",
};
const consent = { request_id: U1, csrf: CSRF, decision: "approve" };

const pairing = [
  T("PairState", P, [["22 chars", "a".repeat(22)]], pattern([["21 chars", "a".repeat(21)], ["plus", `${"a".repeat(22)}+`]])),
  T("PairAuthorizeQuery", P, [["required fields", authorize], ["with origin port", m(authorize, { origin_port: 3891 })]], [
    ["missing machine_pubkey", "required", m(authorize, { machine_pubkey: DEL })],
    ["unknown field", "additionalProperties", m(authorize, { extra: "x" })],
    ["plain challenge method", "const", m(authorize, { code_challenge_method: "plain" })],
    ["localhost callback", "pattern", m(authorize, { callback: "http://localhost:8080/callback" })],
    ["two-digit port callback", "pattern", m(authorize, { callback: "http://127.0.0.1:80/callback" })],
    ["uppercase machine name", "pattern", m(authorize, { machine_name: "Laptop" })],
    ["42-char challenge", "pattern", m(authorize, { code_challenge: B43.slice(0, 42) })],
    ["bad pubkey", "pattern", m(authorize, { machine_pubkey: ed25519("x").slice(0, 40) })],
    ["v zero", "minimum", m(authorize, { v: 0 })],
    ["v string", "type", m(authorize, { v: "1" })],
    ["41-char version", "maxLength", m(authorize, { yaran_version: "1".repeat(41) })],
    ["origin port zero", "minimum", m(authorize, { origin_port: 0 })],
    ["short state", "pattern", m(authorize, { state: "short" })],
  ]),
  T("PairConsent", P, [["approve", consent], ["deny", m(consent, { decision: "deny" })], ["replace", m(consent, { replace_machine_id: U2 })]], [
    ["unknown decision", "enum", m(consent, { decision: "maybe" })],
    ["missing csrf", "required", m(consent, { csrf: DEL })],
    ["short csrf", "pattern", m(consent, { csrf: "abc" })],
    ["uppercase request id", "pattern", m(consent, { request_id: U1.toUpperCase() })],
    ["unknown field", "additionalProperties", m(consent, { extra: 1 })],
  ]),
  T("PairCallbackQuery", P, [["success", { code: B43, state: STATE }], ["error", { error: "pair_denied", state: STATE }]], [
    ["code and error", "oneOf", { code: B43, error: "pair_denied", state: STATE }],
    ["missing state", "oneOf", { code: B43 }],
    ["short code", "oneOf", { code: "abc", state: STATE }],
  ]),
];

const envelope = {
  error: { code: "signature_expired", message: "The request timestamp is 412 s away from the server clock.", retryable: false },
  request_id: "8d1f2c3b4a5e6f70-LHR",
};
const errorTypes = [
  T("ErrorEnvelope", "error.schema.json", [["plain", envelope], ["with details", m(envelope, { "error.details": { server_time: TS } })]], [
    ["missing request_id", "required", m(envelope, { request_id: DEL })],
    ["camel code", "pattern", m(envelope, { "error.code": "BadCode" })],
    ["string retryable", "type", m(envelope, { "error.retryable": "no" })],
    ["empty message", "minLength", m(envelope, { "error.message": "" })],
    ["bad request id", "pattern", m(envelope, { request_id: "a_b" })],
    ["array details", "type", m(envelope, { "error.details": [] })],
  ]),
  T("ValidationErrorDetails", "error.schema.json", [["one error", { errors: [{ path: "/events/0/id", message: "bad uuid" }] }]], [
    ["21 errors", "maxItems", { errors: Array.from({ length: 21 }, () => ({ path: "/", message: "x" })) }],
    ["missing errors", "required", {}],
    ["item missing path", "required", { errors: [{ message: "x" }] }],
  ]),
];

const manifest = {
  train: "yaran-cloud", version: "1.2.0", tag: "yaran-cloud-v1.2.0", released_at: TS, protocol: { min: 1, max: 1 },
  min_update_from: "1.0.0", security: false, notes_url: "https://github.com/SiavZ/yaran/releases/tag/yaran-cloud-v1.2.0",
  tarball: { url: "https://github.com/SiavZ/yaran/releases/download/yaran-cloud-v1.2.0/worker.tar.gz", sha256: AUD },
};
const release = [
  T("ReleaseManifest", "release-manifest.schema.json", [["release", manifest]], [
    ["wrong train", "const", m(manifest, { train: "yaran" })],
    ["bad tag", "pattern", m(manifest, { tag: "v1.2.0" })],
    ["uppercase sha", "pattern", m(manifest, { "tarball.sha256": AUD.toUpperCase() })],
    ["http tarball", "pattern", m(manifest, { "tarball.url": "http://example.com/w.tgz" })],
    ["missing notes_url", "required", m(manifest, { notes_url: DEL })],
    ["string security", "type", m(manifest, { security: "yes" })],
  ]),
];

export const cases = [...common, ...meta, ...pairing, ...errorTypes, ...release];
