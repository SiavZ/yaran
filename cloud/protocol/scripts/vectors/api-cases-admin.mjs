/**
 * API fixture cases for the admin schema (W17-W28).
 *
 * Valid values plus one-change invalid values naming the failing JSON Schema keyword.
 * AdminMachine and AdminDevice build on the MachineSummary and Device values of the
 * machine case module so the allOf composition is exercised with the same data.
 *
 * - Data only; deterministic.
 *
 * <module-headers:begin>
 * Uses:
 * scripts/vectors/api-cases-admin.mjs
 * ├── scripts/vectors/api-cases-machine.mjs
 * └── scripts/vectors/api-values.mjs
 * External: none
 *
 * Used by:
 * scripts/vectors/api-cases-admin.mjs
 * └── scripts/vectors/api.mjs
 * <module-headers:end>
 */
import { device, summary } from "./api-cases-machine.mjs";
import { CP, DEL, EMAIL, FP, m, T, TS, TS2, U1, U2 } from "./api-values.mjs";

const A = "admin.schema.json";
const user = { id: U1, email: EMAIL, role: "admin", disabled: false, created_at: TS, last_seen_at: TS2, machines: 2, devices: 1 };
const machine = {
  ...summary, owner_email: EMAIL, key_fingerprint: FP, origin_port: 3890, tunnel_id: U2, access_app_id: "0a1b2c3d-app", token_version: 2,
  provisioning: { state: "complete", last_error_code: null },
};
const adminDevice = { ...device, owner_email: EMAIL };
const audit = {
  id: U1, ts: TS, actor: { kind: "user", id: U2, email: EMAIL }, action: "machine.claimed", target: { kind: "machine", id: U1 },
  result: "ok", country: "GB",
};
const auditMinimal = { id: U2, ts: TS, actor: { kind: "system" }, action: "drift.repaired", target: { kind: "org" }, result: "error", error_code: "cloudflare_unavailable" };
const settings = {
  org_name: "Example Org", session_duration: "24h",
  pairing_policy: { mode: "everyone", emails: [], domains: [], access_group_ids: [] },
  machine_cap_per_user: 10, device_cap_per_user: 10,
  push: { enabled: true, detail: "names", ttl_seconds: 3600, relay_allowed: true, allowed_relays: [] },
  stale_machine_policy: { notify_after_days: 30, revoke_after_days: null },
  audit_retention_days: 365, quota_limits: { access_apps: 500, access_policies: 500, tunnels: 1000 },
  orphan_cleanup: "delete", deployer_repo_url: null,
};
const allowlist = m(settings, {
  pairing_policy: { mode: "allowlist", emails: [EMAIL], domains: ["example.org"], access_group_ids: ["grp-1"] },
  "push.allowed_relays": ["https://relay.example.com"], "stale_machine_policy.revoke_after_days": 90,
  deployer_repo_url: "https://github.com/example/yaran", session_duration: "15m",
});
const status = { current: "1.0.0", latest: null, update_available: false, security: false, checked_at: TS, error: "couldn't reach the release manifest" };
const page = (items) => ({ items, next_cursor: null });

export const cases = [
  T("AdminUser", A, [["admin", user]], [
    ["unknown role", "enum", m(user, { role: "owner" })], ["negative machines", "minimum", m(user, { machines: -1 })],
    ["string disabled", "type", m(user, { disabled: "no" })], ["missing devices", "required", m(user, { devices: DEL })],
  ]),
  T("AdminUserPatch", A, [["promote", { role: "admin" }], ["disable and revoke", { disabled: true, revoke_all: true }], ["enable", { disabled: false }]], [
    ["empty", "minProperties", {}], ["revoke while enabling", "dependentSchemas", { disabled: false, revoke_all: true }],
    ["revoke alone", "dependentSchemas", { revoke_all: true }], ["unknown field", "additionalProperties", { role: "user", extra: 1 }],
    ["unknown role", "enum", { role: "owner" }],
  ]),
  T("AdminMachine", A, [["machine", machine], ["failed provisioning", m(machine, { provisioning: { state: "failed", last_error_code: "hostname_conflict" } })]], [
    ["bad fingerprint", "pattern", m(machine, { key_fingerprint: "abc" })], ["missing tunnel_id", "required", m(machine, { tunnel_id: DEL })],
    ["unknown provisioning state", "enum", m(machine, { "provisioning.state": "stuck" })], ["unknown status", "enum", m(machine, { status: "broken" })],
    ["empty app id", "minLength", m(machine, { access_app_id: "" })], ["token version zero", "minimum", m(machine, { token_version: 0 })],
  ]),
  T("AdminDevice", A, [["device", adminDevice]], [
    ["missing owner_email", "required", m(adminDevice, { owner_email: DEL })], ["bad owner_email", "format", m(adminDevice, { owner_email: "ada" })],
  ]),
  T("AdminRotateRequest", A, [["kill", { kill_connections: true }], ["keep", { kill_connections: false }]], [
    ["missing", "required", {}], ["string", "type", { kill_connections: "yes" }], ["unknown field", "additionalProperties", { kill_connections: true, extra: 1 }],
  ]),
  T("AuditEntry", A, [["user action", audit], ["system error", auditMinimal]], [
    ["camel action", "pattern", m(audit, { action: "Machine.Claimed" })], ["unknown actor kind", "enum", m(audit, { "actor.kind": "robot" })],
    ["unknown target kind", "enum", m(audit, { "target.kind": "tunnel" })], ["unknown result", "enum", m(audit, { result: "maybe" })],
    ["lowercase country", "pattern", m(audit, { country: "gb" })], ["missing actor", "required", m(audit, { actor: DEL })],
    ["bad actor email", "format", m(audit, { "actor.email": "ada" })],
  ]),
  T("Settings", A, [["defaults", settings], ["allowlist", allowlist]], [
    ["zero hours", "pattern", m(settings, { session_duration: "0h" })], ["seconds", "pattern", m(settings, { session_duration: "15s" })],
    ["machine cap 51", "maximum", m(settings, { machine_cap_per_user: 51 })], ["machine cap 0", "minimum", m(settings, { machine_cap_per_user: 0 })],
    ["device cap 21", "maximum", m(settings, { device_cap_per_user: 21 })], ["ttl 59", "minimum", m(settings, { "push.ttl_seconds": 59 })],
    ["ttl 86401", "maximum", m(settings, { "push.ttl_seconds": 86401 })], ["http relay", "pattern", m(settings, { "push.allowed_relays": ["http://relay.example.com"] })],
    ["21 relays", "maxItems", m(settings, { "push.allowed_relays": Array.from({ length: 21 }, () => CP) })],
    ["notify after 0", "oneOf", m(settings, { "stale_machine_policy.notify_after_days": 0 })],
    ["retention 29", "minimum", m(settings, { audit_retention_days: 29 })], ["retention 3651", "maximum", m(settings, { audit_retention_days: 3651 })],
    ["zero tunnels", "minimum", m(settings, { "quota_limits.tunnels": 0 })], ["unknown cleanup", "enum", m(settings, { orphan_cleanup: "ignore" })],
    ["http repo", "oneOf", m(settings, { deployer_repo_url: "http://github.com/x" })], ["unknown mode", "enum", m(settings, { "pairing_policy.mode": "nobody" })],
    ["bad allowlist email", "format", m(settings, { "pairing_policy.emails": ["ada"] })],
    ["501 emails", "maxItems", m(settings, { "pairing_policy.emails": Array.from({ length: 501 }, () => EMAIL) })],
    ["unknown field", "additionalProperties", m(settings, { extra: 1 })], ["unknown push field", "additionalProperties", m(settings, { "push.extra": 1 })],
    ["missing push", "required", m(settings, { push: DEL })], ["empty org name", "minLength", m(settings, { org_name: "" })],
  ]),
  T("UpdateStatus", A, [["could not check", status], ["update available", m(status, { latest: "1.1.0", update_available: true, error: null, notes_url: "https://github.com/SiavZ/yaran/releases" })]], [
    ["201-char error", "oneOf", m(status, { error: "e".repeat(201) })], ["bad current", "pattern", m(status, { current: "1.0" })],
    ["missing error", "required", m(status, { error: DEL })], ["string update_available", "type", m(status, { update_available: "no" })],
  ]),
  T("AdminUserPage", A, [["page", page([user])]], [["missing next_cursor", "required", { items: [user] }]]),
  T("AdminMachinePage", A, [["page", page([machine])]], [["missing next_cursor", "required", { items: [] }]]),
  T("AdminDevicePage", A, [["page", page([adminDevice])]], [["missing next_cursor", "required", { items: [] }]]),
  T("AuditPage", A, [["page", page([audit, auditMinimal])]], [["missing next_cursor", "required", { items: [] }]]),
];
