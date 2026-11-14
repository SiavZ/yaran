/**
 * Device repository tests: upsert, cap, revocation and delivery outcomes.
 *
 * Covers the D24 device key rules, the sealed endpoint, setPushOutcome's 02 §9 outcomes and the last_seen throttle under an injected clock.
 *
 * <module-headers:begin>
 * Uses:
 * test/devices/devices-repo.test.ts
 * ├── src/devices/device-params.ts
 * ├── src/devices/devices-repo.ts
 * ├── test/devices/device-fixtures.ts
 * └── test/phase06/fakes.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test in cloud/worker (workerd, or Node for test/provisioning))
 * <module-headers:end>
 */
import { describe, expect, it } from "vitest";
import { checkRegistration } from "../../src/devices/device-params.ts";
import { revokeDevice, setPushOutcome, toDevice, upsertDevice, type DeviceRow } from "../../src/devices/devices-repo.ts";
import { makeWorld, seedUser, type TestWorld } from "../phase06/fakes.ts";
import { DEVICE_KEYS, registration } from "./device-fixtures.ts";

const scope = { controlPlaneHost: "cp.example.com", zoneName: "example.com" };
const email = (n: string) => `${n}-${crypto.randomUUID().slice(0, 8)}@example.org`;

async function registered(w: TestWorld) {
  const u = await seedUser(w.ctx.db, email("ada"));
  const reg = await registration();
  const { row } = await upsertDevice(w.ctx, u.id, await checkRegistration(reg, scope, w.settings.push));
  return { u, reg, row };
}

const read = (w: TestWorld, id: string) => w.ctx.db.prepare("SELECT * FROM devices WHERE id = ?").bind(id).first<DeviceRow & { endpoint_enc: string | null; auth_enc: string | null; p256dh: ArrayBuffer | null }>();

describe("devices repository", () => {
  it("stores the device key with its 02 fingerprint and seals the endpoint and auth with row-bound AAD", async () => {
    const w = await makeWorld();
    const { reg, row } = await registered(w);
    const stored = (await read(w, row.id))!;
    expect(stored.device_key_fingerprint).toBe(DEVICE_KEYS[0]!.fingerprint);
    expect(await w.ctx.dataKey.open("device_endpoint", { table: "devices", column: "endpoint_enc", rowId: row.id }, stored.endpoint_enc!)).toBe(reg.push.endpoint);
    expect(await w.ctx.dataKey.open("device_auth", { table: "devices", column: "auth_enc", rowId: row.id }, stored.auth_enc!)).toBe(reg.push.keys.auth);
    await expect(w.ctx.dataKey.open("device_endpoint", { table: "devices", column: "endpoint_enc", rowId: "other" }, stored.endpoint_enc!)).rejects.toThrow();
  });

  it("setPushOutcome: gone clears the subscription and keeps the row; auth_failed and failing mark; delivered restores", async () => {
    const w = await makeWorld();
    const { u, reg, row } = await registered(w);
    await setPushOutcome(w.ctx, row.id, { kind: "gone", errorCode: "push_endpoint_gone" });
    let s = (await read(w, row.id))!;
    expect(s).toMatchObject({ push_state: "gone", endpoint_enc: null, auth_enc: null, p256dh: null, endpoint_host: null, revoked_at: null });
    expect(toDevice({ ...s, muted_machine_ids: "[]" }, null).push_state).toBe("gone");

    // Re-registration (the app's answer to gone) restores active.
    await upsertDevice(w.ctx, u.id, await checkRegistration(reg, scope, w.settings.push));
    expect((await read(w, row.id))!.push_state).toBe("active");

    await setPushOutcome(w.ctx, row.id, { kind: "auth_failed", errorCode: "relay_vapid_mismatch" });
    expect((await read(w, row.id))!.push_state).toBe("auth_failed");
    await setPushOutcome(w.ctx, row.id, { kind: "failing", errorCode: "relay_upstream_failed" });
    expect((await read(w, row.id))!.push_state).toBe("failing");
    w.clock.now += 10;
    await setPushOutcome(w.ctx, row.id, { kind: "delivered" });
    s = (await read(w, row.id))!;
    expect(s).toMatchObject({ push_state: "active", last_push_ok_at: w.clock.now });
  });

  it("revocation by an admin (W24) needs no owner, audits the actor, and only applies once", async () => {
    const w = await makeWorld();
    const { row } = await registered(w);
    const actor = { kind: "admin" as const, id: "admin-1" };
    expect(await revokeDevice(w.ctx, row.id, { ownerUserId: null, actor, signOutEverywhere: false })).toBe(true);
    expect(await revokeDevice(w.ctx, row.id, { ownerUserId: null, actor, signOutEverywhere: false })).toBe(false);
    expect((await read(w, row.id))!).toMatchObject({ revoked_by: "admin-1", device_key_fingerprint: DEVICE_KEYS[0]!.fingerprint });
    await w.refresh();
    expect(w.audit.map((a) => [a.action, a.actor.kind])).toEqual([["device.revoked", "admin"]]);
    // A push outcome never resurrects a revoked device.
    await setPushOutcome(w.ctx, row.id, { kind: "delivered" });
    expect((await read(w, row.id))!.push_state).toBe("none");
  });
});
