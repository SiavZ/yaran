/**
 * Admin services: the settings form against 02's fixtures, saving with side effects, the
 * last-admin rule, disable-and-revoke ordering, audit queries, export and retention.
 *
 * <module-headers:begin>
 * Uses:
 * test/admin-services.test.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── cloud/protocol/fixtures/api/Settings.json
 * ├── src/admin/audit-query.ts
 * ├── src/admin/settings-apply.ts
 * ├── src/admin/settings-schema.ts
 * ├── src/admin/settings-store.ts
 * ├── src/admin/users.ts
 * ├── src/setup/steps/common.ts
 * └── test/helpers/deps.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test in cloud/worker (workerd, or Node for test/provisioning))
 * <module-headers:end>
 */
import { describe, expect, test } from "vitest";
import fixtures from "@yaran/protocol/fixtures/api/Settings.json" with { type: "json" };
import type { Settings } from "@yaran/protocol";
import { exportAuditJsonl, queryAudit, sweepAudit } from "../src/admin/audit-query.ts";
import { saveSettings } from "../src/admin/settings-apply.ts";
import { getPath, parseSettingsForm, readSettings, SETTINGS_FIELDS, validateSettings } from "../src/admin/settings-schema.ts";
import { writeKeys } from "../src/admin/settings-store.ts";
import { patchUser } from "../src/admin/users.ts";
import { advance } from "../src/setup/steps/common.ts";
import { closedOrg, DEVICE_ID, MACHINE_ID, seedDevice, seedMachine, seedUser, type TestWorld, world } from "./helpers/deps.ts";

/** The form a browser would submit for a settings object. */
function formFor(value: unknown): FormData {
  const f = new FormData();
  for (const field of SETTINGS_FIELDS) {
    const v = getPath(value, field.path);
    if (field.kind === "checkbox") {
      if (v === true) f.set(field.path, "on");
    } else f.set(field.path, Array.isArray(v) ? v.join("\n") : v === null || v === undefined ? "" : String(v));
  }
  return f;
}

describe("settings form", () => {
  test("covers every leaf of 02's Settings and nothing else", () => {
    const leaves = (o: unknown, pre = ""): string[] =>
      Object.entries(o as object).flatMap(([k, v]) => (v && typeof v === "object" && !Array.isArray(v) ? leaves(v, `${pre}${k}.`) : [`${pre}${k}`]));
    expect(SETTINGS_FIELDS.map((f) => f.path).sort()).toEqual(leaves(fixtures.valid[0]!.value).sort());
  });
  test.each(fixtures.valid.map((c) => [c.name, c.value]))("valid fixture %s survives the form and validates", (_n, value) => {
    expect(parseSettingsForm(formFor(value))).toEqual(value);
    expect(validateSettings(parseSettingsForm(formFor(value))).valid).toBe(true);
  });
  test.each(fixtures.invalid.map((c) => [c.name, c.value]))("invalid fixture %s is refused", (_n, value) => {
    expect(validateSettings(value).valid).toBe(false);
  });
});

async function setupDone(w: TestWorld) {
  await advance(w.db, { step: "token" }, { kind: "probe_ok", account_id: "acc1", admin_email: "ada@example.org", script_name: "yaran-cloud" }, w.clock.now);
}

describe("saving settings", () => {
  test("validates first, stores, audits, and applies the policy and session side effects", async () => {
    const w = await world();
    await setupDone(w);
    const next: Settings = { ...(await readSettings(w.db)), session_duration: "12h", pairing_policy: { mode: "allowlist", emails: ["bob@example.org"], domains: [], access_group_ids: [] } };
    const out = await saveSettings(w.deps, { user_id: "u1", email: "ada@example.org", role: "admin" }, next);
    expect(out).toEqual({ ok: true, changed: ["session_duration", "pairing_policy"], effects: [{ what: "pairing_policy", ok: true }, { what: "session_duration", ok: true }] });
    expect((await readSettings(w.db)).session_duration).toBe("12h");
    // The session change asks 05 for a reconcile, whose drift pass re-applies the apps.
    expect((await w.db.prepare("SELECT action FROM audit_log WHERE action = 'machine.reconciled'").all()).results).toHaveLength(1);
    expect(w.cf.policies[0]!.include).toEqual([{ email: { email: "ada@example.org" } }, { email: { email: "bob@example.org" } }]);
    expect(w.audits).toMatchObject([{ action: "settings.updated", detail: { changed: ["session_duration", "pairing_policy"] } }]);
  });
  test("refuses invalid settings and everyone-with-One-time-PIN, saving nothing", async () => {
    const w = await world();
    await setupDone(w);
    expect((await saveSettings(w.deps, { user_id: "u1", email: "a@b.c", role: "admin" }, { org_name: "x" })).ok).toBe(false);
    w.cf.idps.push({ id: "otp", name: "One-time PIN", type: "onetimepin" });
    const everyone = { ...(await readSettings(w.db)), pairing_policy: { mode: "everyone", emails: [], domains: [], access_group_ids: [] } };
    const out = await saveSettings(w.deps, { user_id: "u1", email: "a@b.c", role: "admin" }, everyone);
    expect(out).toMatchObject({ ok: false, code: "validation_failed", errors: [{ path: "/pairing_policy/mode" }] });
    expect((await readSettings(w.db)).pairing_policy.mode).toBe("allowlist");
    expect(w.audits).toHaveLength(0);
  });
});

describe("users", () => {
  const actor = { user_id: "u-admin", email: "ada@example.org", role: "admin" as const };
  test("refuses demoting or disabling the last active admin", async () => {
    const w = await world();
    const ada = await seedUser(w, "ada@example.org", "admin");
    expect(await patchUser(w.deps, actor, ada, { role: "user" })).toEqual({ ok: false, code: "last_admin" });
    expect(await patchUser(w.deps, actor, ada, { disabled: true })).toEqual({ ok: false, code: "last_admin" });
    await seedUser(w, "bob@example.org", "admin");
    expect((await patchUser(w.deps, actor, ada, { role: "user" })).ok).toBe(true);
    expect(w.audits.map((a) => a.action)).toEqual(["user.role_changed"]);
  });
  test("disable with revoke_all tears down machines, then phones, then sessions", async () => {
    const w = await world();
    await closedOrg(w);
    const id = await seedUser(w, "ada@example.org");
    await seedMachine(w);
    await seedDevice(w);
    const out = await patchUser(w.deps, actor, id, { disabled: true, revoke_all: true });
    expect(out.ok && out.user.disabled).toBe(true);
    expect(await w.db.prepare("SELECT revoke_reason FROM machines WHERE id = ?").bind(MACHINE_ID).first()).toEqual({ revoke_reason: "user_disabled" });
    expect((await w.db.prepare("SELECT revoked_at FROM devices WHERE id = ?").bind(DEVICE_ID).first<{ revoked_at: number | null }>())!.revoked_at).not.toBeNull();
    expect(w.cf.calls).toContain("POST /accounts/acc1/access/organizations/revoke_user");
    expect(w.audits).toMatchObject([{ action: "user.disabled", detail: { revoke_all: true } }]);
  });
  test("revoke_all without disabled is refused", async () => {
    const w = await world();
    const id = await seedUser(w, "ada@example.org");
    expect(await patchUser(w.deps, actor, id, { revoke_all: true })).toEqual({ ok: false, code: "validation_failed" });
  });
});

describe("audit", () => {
  async function seedAudit(w: TestWorld) {
    await seedUser(w, "ada@example.org", "admin");
    const rows: [string, number, string, string, string, string][] = [
      ["a1", 100, "admin", "00000000-0000-4000-8000-0000000000a1", "settings.updated", "ok"],
      ["a2", 200, "system", "", "machine.revoked", "ok"],
      ["a3", 300, "admin", "00000000-0000-4000-8000-0000000000a1", "user.disabled", "failed"],
      ["a4", 300, "setup", "", "setup.completed", "ok"],
    ];
    for (const [id, at, kind, actor, action, outcome] of rows) {
      await w.db.prepare("INSERT INTO audit_log (id, at, actor_kind, actor_id, action, target_kind, outcome, error_code) VALUES (?, ?, ?, ?, ?, 'org', ?, ?)").bind(id, at, kind, actor || null, action, outcome, outcome === "ok" ? null : "last_admin").run();
    }
  }
  test("pages newest first with a stable cursor and maps to AuditEntry", async () => {
    const w = await world();
    await seedAudit(w);
    const p1 = await queryAudit(w.db, {}, 2);
    expect(p1.items.map((e) => e.id)).toEqual(["a4", "a3"]);
    expect(p1.items[1]).toMatchObject({ actor: { kind: "user", email: "ada@example.org" }, result: "error", error_code: "last_admin" });
    expect(p1.items[0]!.actor.kind).toBe("system");
    const p2 = await queryAudit(w.db, {}, 2, p1.next_cursor);
    expect(p2.items.map((e) => e.id)).toEqual(["a2", "a1"]);
    expect(p2.next_cursor).toBeNull();
  });
  test("filters by actor email, action and date range, and exports the filter as JSON Lines", async () => {
    const w = await world();
    await seedAudit(w);
    expect((await queryAudit(w.db, { actor: "Ada@example.org" }, 10)).items.map((e) => e.id)).toEqual(["a3", "a1"]);
    expect((await queryAudit(w.db, { action: "machine.revoked" }, 10)).items.map((e) => e.id)).toEqual(["a2"]);
    expect((await queryAudit(w.db, { since: new Date(150_000).toISOString(), until: new Date(250_000).toISOString() }, 10)).items.map((e) => e.id)).toEqual(["a2"]);
    const lines = (await exportAuditJsonl(w.db, { actor: "ada@example.org" })).trim().split("\n").map((l) => JSON.parse(l).id);
    expect(lines).toEqual(["a3", "a1"]);
  });
  test("the retention sweep deletes only rows older than the setting", async () => {
    const w = await world();
    await seedAudit(w);
    const now = new Date((300 + 30 * 86_400) * 1000);
    expect(await sweepAudit(w.db, 30, now, 500)).toBe(2);
    expect((await queryAudit(w.db, {}, 10)).items.map((e) => e.id)).toEqual(["a4", "a3"]);
  });
});

test("readSettings fills missing rows with defaults", async () => {
  const w = await world();
  await writeKeys(w.db, { org_name: "Acme" }, "t", w.clock.now);
  const s = await readSettings(w.db);
  expect(s.org_name).toBe("Acme");
  expect(validateSettings(s).valid).toBe(true);
});
