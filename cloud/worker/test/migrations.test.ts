/**
 * `0001_init.sql`: applies on an empty database (setup.ts applies it per file), every
 * CHECK rejects a bad row (one case per constraint), the one-live-op partial index holds,
 * and foreign keys are enforced.
 *
 * <module-headers:begin>
 * Uses:
 * test/migrations.test.ts
 * ├── src/db/client.ts
 * └── test/helpers/seed.ts
 * External: cloudflare:test, vitest
 *
 * Used by: entry point (vitest, via npm test in cloud/worker (workerd, or Node for test/provisioning))
 * <module-headers:end>
 */
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { Param } from "../src/db/client.ts";
import { NOW } from "./helpers/seed.ts";

let n = 0;
const uid = () => crypto.randomUUID();
const bytes = (len: number) => new Uint8Array(len);
let userId = "";
let machineId = "";

/** A valid row per table, fresh on every call. */
const VALID: Record<string, () => Record<string, Param>> = {
  settings: () => ({ key: `k${++n}`, value: "1", updated_at: NOW }),
  users: () => ({ id: uid(), email: `u${++n}@example.com`, slug: `s${n}`, created_at: NOW }),
  machines: () => ({ id: uid(), instance_id: "0123abcd", owner_user_id: userId, name: `m${++n}`, slug: `m${n}`, public_key: bytes(32), status: "active", created_at: NOW }),
  pair_requests: () => ({ id: uid(), user_id: userId, state_hash: bytes(32), code_challenge: "c".repeat(43), machine_public_key: bytes(32), machine_name: "m", callback_port: 4000, status: "pending", created_at: NOW, expires_at: NOW }),
  devices: () => ({ id: uid(), user_id: userId, install_id: uid(), platform: "android", flavor: "foss", form_factor: "phone", push_kind: "none", device_key: bytes(65), device_key_fingerprint: "A".repeat(29), app_version: "1.0.0", label: "Phone", created_at: NOW }),
  audit_log: () => ({ id: uid(), at: NOW, actor_kind: "system", action: "setup.completed", outcome: "ok" }),
  provisioning_ops: () => ({ id: uid(), machine_id: machineId, kind: "provision", state: "succeeded", step: "P0", next_attempt_at: NOW, requested_by: "x", created_at: NOW, updated_at: NOW }),
  cf_orphans: () => ({ resource_kind: "tunnel", resource_id: uid(), marker: "m", first_seen_at: NOW, last_seen_at: NOW }),
  cf_api_budget: () => ({ id: 1, observed_at: NOW }),
  scheduled_tasks: () => ({ task: `t${++n}`, next_run_at: NOW }),
  handoff_csrf: () => ({ token_hash: crypto.getRandomValues(new Uint8Array(32)), state_hash: bytes(32), pk_thumbprint: "t".repeat(43), dk_fingerprint: "A".repeat(29), verified: 0, user_id: userId, expires_at: NOW }),
};

async function insert(table: string, row: Record<string, Param>): Promise<void> {
  const cols = Object.keys(row);
  await env.DB.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).bind(...Object.values(row)).run();
}

const CHECKS: [string, string, Record<string, Param>][] = [
  ["settings", "key length", { key: "" }],
  ["settings", "value is JSON", { value: "{nope" }],
  ["users", "email lowercase", { email: "Upper@Example.com" }],
  ["users", "email length", { email: "a@" }],
  ["users", "slug charset", { slug: "Bad_Slug" }],
  ["users", "slug length", { slug: "x".repeat(25) }],
  ["users", "role", { role: "root" }],
  ["users", "status", { status: "gone" }],
  ["machines", "name charset", { name: "My Machine" }],
  ["machines", "name length", { name: "m".repeat(33) }],
  ["machines", "slug charset", { slug: "a.b" }],
  ["machines", "public key length", { public_key: bytes(31) }],
  ["machines", "origin port", { origin_port: 0 }],
  ["machines", "ingress origin port", { ingress_origin_port: 70000 }],
  ["machines", "yaran version length", { yaran_version: "1".repeat(41) }],
  ["machines", "status", { status: "zombie" }],
  ["machines", "cf status", { cf_status: "fine" }],
  ["machines", "revoke reason", { revoke_reason: "bored" }],
  ["pair_requests", "state hash length", { state_hash: bytes(31) }],
  ["pair_requests", "code hash length", { code_hash: bytes(16) }],
  ["pair_requests", "code challenge length", { code_challenge: "c".repeat(42) }],
  ["pair_requests", "machine key length", { machine_public_key: bytes(33) }],
  ["pair_requests", "machine name length", { machine_name: "m".repeat(33) }],
  ["pair_requests", "callback port", { callback_port: 80 }],
  ["pair_requests", "origin port", { origin_port: 65536 }],
  ["pair_requests", "status", { status: "maybe" }],
  ["devices", "platform", { platform: "web" }],
  ["devices", "flavor", { flavor: "beta" }],
  ["devices", "form factor", { form_factor: "watch" }],
  ["devices", "locale length", { locale: "x".repeat(36) }],
  ["devices", "push kind", { push_kind: "sms" }],
  ["devices", "push distributor length", { push_distributor: "x".repeat(129) }],
  ["devices", "vapid key length", { push_vapid_public_key: bytes(64) }],
  ["devices", "device key length", { device_key: bytes(33) }],
  ["devices", "device key fingerprint length", { device_key_fingerprint: "A".repeat(28) }],
  ["devices", "app version length", { app_version: "1".repeat(49) }],
  ["devices", "label length", { label: "" }],
  ["audit_log", "actor kind", { actor_kind: "god" }],
  ["audit_log", "target kind", { target_kind: "planet" }],
  ["audit_log", "outcome", { outcome: "meh" }],
  ["audit_log", "country length", { country: "SWE" }],
  ["audit_log", "detail is JSON", { detail: "{nope" }],
  ["audit_log", "detail length", { detail: JSON.stringify({ x: "y".repeat(2050) }) }],
  ["provisioning_ops", "kind", { kind: "explode" }],
  ["provisioning_ops", "state", { state: "dreaming" }],
  ["provisioning_ops", "params is JSON", { params: "{nope" }],
  ["provisioning_ops", "last error length", { last_error: "e".repeat(1025) }],
  ["cf_orphans", "resource kind", { resource_kind: "worker" }],
  ["cf_api_budget", "single row", { id: 2 }],
  ["scheduled_tasks", "last error length", { last_error: "e".repeat(1025) }],
  // 0006_pairing.sql
  ["pair_requests", "yaran version length", { yaran_version: "v".repeat(41) }],
  ["pair_requests", "csrf hash length", { csrf_hash: bytes(31) }],
  ["devices", "push state", { push_state: "asleep" }],
  ["devices", "mute all is boolean", { mute_all: 2 }],
  ["handoff_csrf", "token hash length", { token_hash: bytes(31) }],
  ["handoff_csrf", "state hash length", { state_hash: bytes(31) }],
  ["handoff_csrf", "pk thumbprint length", { pk_thumbprint: "t".repeat(42) }],
  ["handoff_csrf", "dk fingerprint length", { dk_fingerprint: "A".repeat(28) }],
  ["handoff_csrf", "verified is boolean", { verified: 2 }],
];

beforeAll(async () => {
  const u = VALID.users!();
  await insert("users", u);
  userId = u.id as string;
  const m = VALID.machines!();
  await insert("machines", m);
  machineId = m.id as string;
});

describe("0001_init.sql", () => {
  it("accepts a valid row in every table", async () => {
    for (const [table, row] of Object.entries(VALID)) {
      if (table === "cf_api_budget") continue;
      await insert(table, row());
    }
  });
  it.each(CHECKS)("%s rejects a bad row: %s", async (table, _name, patch) => {
    await expect(insert(table, { ...VALID[table]!(), ...patch })).rejects.toThrow(/CHECK constraint failed/);
  });
  it("covers every CHECK in the schema with at least one case", async () => {
    const tables = await env.DB.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND sql LIKE '%CHECK%'").all<{ name: string; sql: string }>();
    for (const { name, sql } of tables.results) {
      const checks = sql.match(/CHECK/g)!.length;
      expect(CHECKS.filter(([t]) => t === name).length, name).toBeGreaterThanOrEqual(checks);
    }
  });
  it("allows one live provisioning op per machine", async () => {
    await insert("provisioning_ops", { ...VALID.provisioning_ops!(), state: "running" });
    await expect(insert("provisioning_ops", { ...VALID.provisioning_ops!(), state: "pending" })).rejects.toThrow(/UNIQUE/);
    await insert("provisioning_ops", { ...VALID.provisioning_ops!(), state: "failed" });
  });
  it("enforces foreign keys", async () => {
    await expect(insert("machines", { ...VALID.machines!(), owner_user_id: uid() })).rejects.toThrow(/FOREIGN KEY/);
    await expect(insert("devices", { ...VALID.devices!(), user_id: uid() })).rejects.toThrow(/FOREIGN KEY/);
    await expect(insert("provisioning_ops", { ...VALID.provisioning_ops!(), machine_id: uid() })).rejects.toThrow(/FOREIGN KEY/);
  });
  it("keeps one device per install per user", async () => {
    const row = VALID.devices!();
    await insert("devices", row);
    await expect(insert("devices", { ...VALID.devices!(), install_id: row.install_id! })).rejects.toThrow(/UNIQUE/);
  });
});
