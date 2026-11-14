/**
 * Settings schema and repositories (users, machines) against Miniflare's D1.
 *
 * <module-headers:begin>
 * Uses:
 * test/settings.test.ts
 * ├── src/db/client.ts
 * ├── src/db/machines.ts
 * ├── src/db/settings.ts
 * ├── src/db/users.ts
 * ├── test/helpers/machine.ts
 * └── test/helpers/seed.ts
 * External: cloudflare:test, vitest
 *
 * Used by: entry point (vitest inside workerd, via npm test in cloud/worker)
 * <module-headers:end>
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { run } from "../src/db/client.ts";
import { beginRevoke, getMachine, markActive, markAwaitingClaim, markFailed, markRevoked, touchMachineSeen } from "../src/db/machines.ts";
import {
  compareAndSetSetting, DEFAULT_SETTINGS, getSetting, getSettings, isSettingKey, readContractSettings, setSetting, settingStatement, type SettingKey,
} from "../src/db/settings.ts";
import { getUserById, insertUser, setUserRole, setUserStatus } from "../src/db/users.ts";
import { machineKeys } from "./helpers/machine.ts";
import { NOW, seedMachine, seedUser } from "./helpers/seed.ts";

describe("settings", () => {
  it("falls back to defaults, and to null for keys without one", async () => {
    expect(await readContractSettings(env.DB)).toEqual(DEFAULT_SETTINGS);
    expect(await getSettings(env.DB, ["setup_state", "jwt_clock_tolerance_s", "team_domain"])).toEqual({ setup_state: "open", jwt_clock_tolerance_s: 60, team_domain: null });
  });
  it("validates contract keys with 02's schema and internal keys with their own rule", async () => {
    await setSetting(env.DB, "audit_retention_days", 400, "admin-1", NOW);
    expect(await getSetting(env.DB, "audit_retention_days")).toBe(400);
    expect(() => settingStatement(env.DB, "audit_retention_days", 10, null, NOW)).toThrow(/audit_retention_days/);
    expect(() => settingStatement(env.DB, "session_duration", "1d", null, NOW)).toThrow(/session_duration/);
    expect(() => settingStatement(env.DB, "team_domain", "evil.example.com", null, NOW)).toThrow(/team_domain/);
    expect(() => settingStatement(env.DB, "jwt_clock_tolerance_s", 301, null, NOW)).toThrow();
  });
  it("is loud about an invalid stored value", async () => {
    await run(env.DB, "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('machine_cap_per_user', '0', ?)", NOW);
    await expect(getSetting(env.DB, "machine_cap_per_user")).rejects.toThrow(/machine_cap_per_user holds an invalid value/);
    await run(env.DB, "DELETE FROM settings WHERE key = 'machine_cap_per_user'");
  });
  it("refuses an unknown key", async () => {
    expect(isSettingKey("setup_state")).toBe(true);
    expect(isSettingKey("nope")).toBe(false);
    await expect(getSetting(env.DB, "nope" as SettingKey)).rejects.toThrow(/unknown settings key nope/);
  });
  it("compare-and-set writes only over the expected value", async () => {
    expect(await compareAndSetSetting(env.DB, "orphan_grace_minutes", null, 5, NOW)).toBe(true);
    expect(await compareAndSetSetting(env.DB, "orphan_grace_minutes", null, 6, NOW)).toBe(false);
    expect(await compareAndSetSetting(env.DB, "orphan_grace_minutes", 4, 6, NOW)).toBe(false);
    expect(await compareAndSetSetting(env.DB, "orphan_grace_minutes", 5, 6, NOW)).toBe(true);
    expect(await getSetting(env.DB, "orphan_grace_minutes")).toBe(6);
  });
});

describe("users repository", () => {
  it("inserts once per email and guards role and status changes", async () => {
    const id = crypto.randomUUID();
    expect(await insertUser(env.DB, { id, email: "Repo@Example.com", slug: "repo", role: "user", accessSub: null, now: NOW })).toBe(true);
    expect(await insertUser(env.DB, { id: crypto.randomUUID(), email: "repo@example.com", slug: "repo-2", role: "user", accessSub: null, now: NOW })).toBe(false);
    expect((await getUserById(env.DB, id))!.email).toBe("repo@example.com");
    expect(await setUserRole(env.DB, id, "user", "admin")).toBe(true);
    expect(await setUserRole(env.DB, id, "user", "admin")).toBe(false);
    expect(await setUserStatus(env.DB, id, "active", "disabled")).toBe(true);
    expect((await getUserById(env.DB, id))).toMatchObject({ role: "admin", status: "disabled" });
  });
});

describe("machines repository", () => {
  it("walks the lifecycle through guarded transitions and releases the hostname", async () => {
    const owner = (await seedUser()).id;
    const { publicKey } = await machineKeys();
    const id = await seedMachine({ owner, publicKey });
    expect((await getMachine(env.DB, id))!.public_key).toEqual(publicKey);
    expect(await markActive(env.DB, id, NOW)).toBe(false);
    expect(await markAwaitingClaim(env.DB, id)).toBe(true);
    expect(await markActive(env.DB, id, NOW)).toBe(true);
    expect(await markFailed(env.DB, id)).toBe(false);
    expect(await markRevoked(env.DB, id, NOW)).toBe(false);
    expect(await beginRevoke(env.DB, id, "user-1", "user_unpair")).toBe(true);
    expect(await markRevoked(env.DB, id, NOW + 5)).toBe(true);
    expect(await getMachine(env.DB, id)).toMatchObject({ status: "revoked", hostname: null, revoked_at: NOW + 5, revoke_reason: "user_unpair", claimed_at: NOW });
  });
  it("lets exactly one of two racing revokes win", async () => {
    const owner = (await seedUser()).id;
    const id = await seedMachine({ owner, publicKey: (await machineKeys()).publicKey, status: "active" });
    const results = await Promise.all([beginRevoke(env.DB, id, "a", "admin_revoke"), beginRevoke(env.DB, id, "b", "user_unpair")]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
  it("throttles the last-seen stamp to once a minute unless the protocol changes", async () => {
    const owner = (await seedUser()).id;
    const id = await seedMachine({ owner, publicKey: (await machineKeys()).publicKey, status: "active" });
    expect(await touchMachineSeen(env.DB, id, 1, NOW)).toBe(true);
    expect(await touchMachineSeen(env.DB, id, 1, NOW + 30)).toBe(false);
    expect(await touchMachineSeen(env.DB, id, 2, NOW + 30)).toBe(true);
    expect(await touchMachineSeen(env.DB, id, 2, NOW + 90)).toBe(true);
  });
});
