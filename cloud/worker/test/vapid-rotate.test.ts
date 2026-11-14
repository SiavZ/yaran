/**
 * Rotating the org's push keys: a new VAPID pair replaces the old one even when the old
 * private key can no longer be opened (a lost DATA_KEY), every registered phone is marked
 * `auth_failed` so it re-registers, and the admin console confirms before rotating.
 *
 * <module-headers:begin>
 * Uses:
 * test/vapid-rotate.test.ts
 * ├── src/admin/settings-store.ts
 * ├── src/admin/vapid-rotate.ts
 * ├── src/console/admin-routes.ts
 * ├── src/setup/steps/keys.ts
 * └── test/helpers/deps.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test in cloud/worker (workerd, or Node for test/provisioning))
 * <module-headers:end>
 */
import { describe, expect, test } from "vitest";
import { readKey, writeKeys } from "../src/admin/settings-store.ts";
import { rotateVapidKey } from "../src/admin/vapid-rotate.ts";
import { ADMIN_ROUTES } from "../src/console/admin-routes.ts";
import { ensureVapidKey, VAPID_AAD, VAPID_PRIVATE_KEY, VAPID_PUBLIC_KEY } from "../src/setup/steps/keys.ts";
import { closedOrg, DEVICE_ID, dispatch, seedDevice, seedUser, world, type TestWorld } from "./helpers/deps.ts";

const CP = "https://cp.example.org";
const ADA = { user_id: "00000000-0000-4000-8000-0000000000a1", email: "ada@example.org", role: "admin" as const };

async function ready(): Promise<TestWorld> {
  const w = await world();
  await closedOrg(w);
  await seedUser(w, "ada@example.org", "admin");
  await seedDevice(w);
  await w.db.prepare("UPDATE devices SET push_state = 'active'").run();
  await ensureVapidKey(w.db, w.deps.sealer, w.clock.now);
  return w;
}

const pushState = (w: TestWorld) => w.db.prepare("SELECT push_state FROM devices WHERE id = ?").bind(DEVICE_ID).first<string>("push_state");

describe("push key rotation", () => {
  test("replaces the pair, makes every phone re-register and audits it", async () => {
    const w = await ready();
    const before = await readKey<string>(w.db, VAPID_PUBLIC_KEY);
    expect(await rotateVapidKey(w.deps, ADA.user_id)).toEqual({ phones: 1 });
    const after = await readKey<string>(w.db, VAPID_PUBLIC_KEY);
    expect(after).toMatch(/^[A-Za-z0-9_-]{87}$/);
    expect(after).not.toBe(before);
    const jwk = JSON.parse(await w.deps.sealer.open("vapid", VAPID_AAD, (await readKey<string>(w.db, VAPID_PRIVATE_KEY))!)) as JsonWebKey;
    expect(jwk.kty).toBe("EC");
    expect(await pushState(w)).toBe("auth_failed");
    expect(w.audits.at(-1)).toMatchObject({ action: "settings.updated", actor: { kind: "admin", id: ADA.user_id }, detail: { changed: ["vapid_public_key"] } });
  });

  test("works when the old private key cannot be opened any more", async () => {
    const w = await ready();
    await writeKeys(w.db, { [VAPID_PRIVATE_KEY]: "k9.unreadable.after-a-lost-data-key" }, "test", w.clock.now);
    await rotateVapidKey(w.deps, ADA.user_id);
    expect(await w.deps.sealer.open("vapid", VAPID_AAD, (await readKey<string>(w.db, VAPID_PRIVATE_KEY))!)).toContain('"d"');
  });

  test("the console confirms first, then rotates and says what happens next", async () => {
    const w = await ready();
    const path = `${CP}/admin/push-keys/rotate`;
    const confirm = await (await dispatch(ADMIN_ROUTES, w, "GET", path, { identity: ADA })).text();
    expect(confirm).toContain("btn-destructive");
    expect(confirm).toContain("registers again");
    expect(await pushState(w)).toBe("active");
    const res = await dispatch(ADMIN_ROUTES, w, "POST", path, { identity: ADA, headers: { Origin: CP }, body: new URLSearchParams() });
    expect(res.status).toBe(303);
    expect(await pushState(w)).toBe("auth_failed");
    const health = await (await dispatch(ADMIN_ROUTES, w, "GET", `${CP}/admin/health`, { identity: ADA, headers: { Cookie: res.headers.get("Set-Cookie")!.split(";")[0]! } })).text();
    expect(health).toContain("Rotated the push keys");
    expect(health).toContain("1 phone");
    expect(health).toContain('href="/admin/push-keys/rotate"');
  });
});
