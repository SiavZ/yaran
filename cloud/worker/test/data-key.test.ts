/**
 * Encryption at rest: sealing, row-bound AAD, key versions across rotations, the
 * remembered-consent MAC key (D24) and the reseal task.
 *
 * <module-headers:begin>
 * Uses:
 * test/data-key.test.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── cloud/protocol/fixtures/handoff/consent-cookie.json
 * ├── src/db/client.ts
 * ├── src/db/settings.ts
 * ├── src/scheduled/purge.ts
 * ├── src/security/data-key.ts
 * ├── test/helpers/app.ts
 * └── test/helpers/seed.ts
 * External: cloudflare:test, vitest
 *
 * Used by: entry point (vitest inside workerd, via npm test in cloud/worker)
 * <module-headers:end>
 */
import { consentMac, toHex, verifyConsentCookie } from "@yaran/protocol";
import consent from "@yaran/protocol/fixtures/handoff/consent-cookie.json";
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { one, run } from "../src/db/client.ts";
import { getSetting, setSetting } from "../src/db/settings.ts";
import { DataKeyError, keyRing, macKey, open, resetKeyRingCache, seal } from "../src/security/data-key.ts";
import { resealChunk } from "../src/scheduled/purge.ts";
import { appCtx, freshDataKey } from "./helpers/app.ts";
import { NOW, seedUser } from "./helpers/seed.ts";

const aad = { table: "devices", column: "endpoint_enc", rowId: "row-1" };

beforeEach(async () => {
  resetKeyRingCache();
  await run(env.DB, "DELETE FROM settings WHERE key = 'data_key_state'");
});

describe("seal and open", () => {
  it("round-trips and binds the ciphertext to its row and column", async () => {
    const ctx = appCtx();
    const sealed = await seal(ctx, "device_endpoint", aad, "https://push.example/abc");
    expect(sealed).toMatch(/^k1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
    expect(new TextDecoder().decode(await open(ctx, "device_endpoint", aad, sealed))).toBe("https://push.example/abc");
    for (const other of [{ ...aad, rowId: "row-2" }, { ...aad, column: "auth_enc" }, { ...aad, table: "settings" }]) {
      await expect(open(ctx, "device_endpoint", other, sealed)).rejects.toBeInstanceOf(DataKeyError);
    }
    await expect(open(ctx, "device_auth", aad, sealed)).rejects.toThrow(/device_auth/);
  });
  it("refuses a tampered IV or ciphertext, and malformed input", async () => {
    const ctx = appCtx();
    const sealed = await seal(ctx, "vapid", aad, new Uint8Array([1, 2, 3]));
    const [v, iv, ct] = sealed.split(".") as [string, string, string];
    const flip = (s: string) => (s[0] === "A" ? "B" : "A") + s.slice(1);
    for (const bad of [`${v}.${flip(iv)}.${ct}`, `${v}.${iv}.${flip(ct)}`, "garbage", `${v}.${iv}`]) {
      await expect(open(ctx, "vapid", aad, bad)).rejects.toThrow(/cannot open the vapid secret/);
    }
  });
});

describe("key versions", () => {
  it("writes version 1 on first boot, and the row holds no key material", async () => {
    await keyRing(appCtx());
    const state = await getSetting(env.DB, "data_key_state");
    expect(state).toMatchObject({ version: 1, previous_check: null });
    const raw = (await one<{ value: string }>(env.DB, "SELECT value FROM settings WHERE key = 'data_key_state'"))!.value;
    expect(Object.keys(JSON.parse(raw) as object).sort()).toEqual(["check", "previous_check", "version"]);
    expect(raw).not.toContain(env.DATA_KEY!);
    expect(raw).not.toContain(consent.worker_key.data_key_hex);
  });

  it("bumps exactly once when two isolates meet a new DATA_KEY, then opens the old version only with a matching DATA_KEY_PREVIOUS", async () => {
    const old = appCtx();
    const sealedOld = await seal(old, "device_auth", aad, "secret-auth");
    const next = freshDataKey();
    resetKeyRingCache();
    const rings = await Promise.all([keyRing(appCtx({ DATA_KEY: next })), (resetKeyRingCache(), keyRing(appCtx({ DATA_KEY: next })))]);
    expect(rings.map((r) => r.version)).toEqual([2, 2]);
    expect((await getSetting(env.DB, "data_key_state"))!.version).toBe(2);

    resetKeyRingCache();
    await expect(open(appCtx({ DATA_KEY: next }), "device_auth", aad, sealedOld)).rejects.toThrow(/version 1 .* version 2/);
    resetKeyRingCache();
    const withPrev = appCtx({ DATA_KEY: next, DATA_KEY_PREVIOUS: env.DATA_KEY });
    expect(new TextDecoder().decode(await open(withPrev, "device_auth", aad, sealedOld))).toBe("secret-auth");

    resetKeyRingCache();
    const spy = vi.spyOn(console, "log");
    const wrongPrev = appCtx({ DATA_KEY: next, DATA_KEY_PREVIOUS: freshDataKey() });
    await expect(open(wrongPrev, "device_auth", aad, sealedOld)).rejects.toBeInstanceOf(DataKeyError);
    expect(spy.mock.calls.some((c) => String(c[0]).includes("data_key_previous_ignored"))).toBe(true);
    spy.mockRestore();

    resetKeyRingCache();
    await expect(open(appCtx({ DATA_KEY: next }), "vapid", aad, "k7.AAAAAAAAAAAAAAAA.AAAA")).rejects.toThrow(/vapid.*version 7/);
  });

  it("refuses to seal in an isolate still holding the rotated-out key", async () => {
    await keyRing(appCtx());
    resetKeyRingCache();
    await keyRing(appCtx({ DATA_KEY: freshDataKey() }));
    resetKeyRingCache();
    await expect(seal(appCtx(), "vapid", aad, "x")).rejects.toMatchObject({ code: "unavailable" });
  });
});

describe("macKey (D24)", () => {
  it("reproduces the consent-cookie fixture key and returns the current version as kv", async () => {
    const mk = await macKey(appCtx({ DATA_KEY: consent.worker_key.data_key_b64 }), "handoff_consent");
    expect(toHex(mk.key)).toBe(consent.worker_key.key_hex);
    expect(mk.kv).toBe(1);
  });
  it("forgets remembered consent after a rotation, even with DATA_KEY_PREVIOUS set", async () => {
    const before = await macKey(appCtx(), "handoff_consent");
    const value = `v1.${before.kv}.${consent.fp24}.${NOW}.${await consentMac(before.key, consent.host, consent.fp24, NOW, before.kv)}`;
    expect(await verifyConsentCookie({ value, host: consent.host, key: before.key, currentKv: before.kv, now: NOW })).toEqual({ ok: true, fp24: consent.fp24 });
    resetKeyRingCache();
    const after = await macKey(appCtx({ DATA_KEY: freshDataKey(), DATA_KEY_PREVIOUS: env.DATA_KEY }), "handoff_consent");
    expect(after.kv).toBe(before.kv + 1);
    expect(await verifyConsentCookie({ value, host: consent.host, key: after.key, currentKv: after.kv, now: NOW })).toMatchObject({ ok: false });
  });
});

describe("reseal_data", () => {
  it("is a no-op without DATA_KEY_PREVIOUS and migrates rows (and sealed settings) when it is set", async () => {
    const u = await seedUser();
    const old = appCtx();
    const id = crypto.randomUUID();
    const rowAad = { table: "devices", column: "endpoint_enc", rowId: id };
    await run(env.DB,
      `INSERT INTO devices (id, user_id, install_id, platform, flavor, form_factor, push_kind, endpoint_enc, device_key, device_key_fingerprint, app_version, label, created_at)
       VALUES (?, ?, ?, 'android', 'foss', 'phone', 'unifiedpush', ?, ?, ?, '1.0.0', 'Phone', ?)`,
      id, u.id, crypto.randomUUID(), await seal(old, "device_endpoint", rowAad, "https://push.example/1"), new Uint8Array(65), "A".repeat(29), NOW);
    const vapidAad = { table: "settings", column: "value", rowId: "vapid_private_key_enc" };
    await setSetting(env.DB, "vapid_private_key_enc", await seal(old, "vapid", vapidAad, "private-jwk"), null, NOW);
    expect(await resealChunk(old)).toEqual({ resealed: 0, done: true, full: false });

    const next = freshDataKey();
    resetKeyRingCache();
    const rotating = appCtx({ DATA_KEY: next, DATA_KEY_PREVIOUS: env.DATA_KEY });
    const spy = vi.spyOn(console, "log");
    expect(await resealChunk(rotating)).toMatchObject({ resealed: 2, done: true });
    expect(spy.mock.calls.some((c) => String(c[0]).includes("data_key_previous_safe_to_remove"))).toBe(true);
    spy.mockRestore();
    resetKeyRingCache();
    const stored = (await one<{ endpoint_enc: string }>(env.DB, "SELECT endpoint_enc FROM devices WHERE id = ?", id))!.endpoint_enc;
    expect(stored.startsWith("k2.")).toBe(true);
    expect(new TextDecoder().decode(await open(appCtx({ DATA_KEY: next }), "device_endpoint", rowAad, stored))).toBe("https://push.example/1");
    const vapid = (await getSetting(env.DB, "vapid_private_key_enc"))!;
    expect(new TextDecoder().decode(await open(appCtx({ DATA_KEY: next }), "vapid", vapidAad, vapid))).toBe("private-jwk");
  });
});
