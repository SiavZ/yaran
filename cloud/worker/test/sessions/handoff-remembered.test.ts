/**
 * D24 remembered consent on the control plane: the cookie is set only by a verified
 * explicit Continue, a later handoff skips the page only when every §8.1 rule holds, and
 * the shared decision-table and cookie fixtures give their expected answers.
 *
 * <module-headers:begin>
 * Uses:
 * test/sessions/handoff-remembered.test.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── cloud/protocol/fixtures/handoff/consent-cookie.json
 * ├── cloud/protocol/fixtures/handoff/remembered-consent.json
 * ├── cloud/protocol/fixtures/sig/device-fingerprint.json
 * ├── src/security/data-key.ts
 * ├── src/sessions/handoff-params.ts
 * ├── src/sessions/handoff-remembered.ts
 * ├── test/helpers/app.ts
 * ├── test/phase06/fakes.ts
 * └── test/sessions/handoff-helpers.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test in cloud/worker (workerd, or Node for test/provisioning))
 * <module-headers:end>
 */
import cookieFx from "@yaran/protocol/fixtures/handoff/consent-cookie.json" with { type: "json" };
import rememberedFx from "@yaran/protocol/fixtures/handoff/remembered-consent.json" with { type: "json" };
import devFpFx from "@yaran/protocol/fixtures/sig/device-fingerprint.json" with { type: "json" };
import { CONSENT_COOKIE_NAME, deviceKeyFingerprint, fromHex } from "@yaran/protocol";
import { resetKeyRingCache } from "../../src/security/data-key.ts";
import { freshDataKey } from "../helpers/app.ts";
import { describe, expect, it } from "vitest";
import type { HandoffGet } from "../../src/sessions/handoff-params.ts";
import { rememberedConsent } from "../../src/sessions/handoff-remembered.ts";
import { APP_CALLBACK, CP_HOST, seedUser, type TestWorld } from "../phase06/fakes.ts";
import { callbackParams, formFromPage, get, handoffQuery, makePhone, post, setup, signDevice, STATE, type Setup } from "./handoff-helpers.ts";

const COOKIE_RE = new RegExp(`^${CONSENT_COOKIE_NAME}=v1\\.(\\d+)\\.([A-Z2-7]{24})\\.(\\d+)\\.[A-Za-z0-9_-]{43}; Path=/v1/handoff; Max-Age=34560000; Secure; HttpOnly; SameSite=Lax$`);

/** GET then Continue; returns the consent cookie header to send next time. */
async function firstHandoff(s: Setup): Promise<string> {
  const res = await post(s, await formFromPage(await get(s, await handoffQuery(s)), "continue"));
  const set = res.headers.get("Set-Cookie")!;
  expect(set).toMatch(COOKIE_RE);
  return set.split(";")[0]!;
}

async function revokeRow(w: TestWorld, userId: string, dk: string, revoked: boolean): Promise<void> {
  await w.ctx.db
    .prepare(
      `INSERT INTO devices (id, user_id, install_id, platform, flavor, form_factor, push_kind, device_key, device_key_fingerprint, app_version, label, created_at, revoked_at)
       VALUES (?, ?, ?, 'android', 'play', 'phone', 'none', ?, ?, '1.0.0', 'Pixel', 0, ?)`,
    )
    .bind(crypto.randomUUID(), userId, crypto.randomUUID(), new Uint8Array(65), await deviceKeyFingerprint(dk), revoked ? w.clock.now : null)
    .run();
}

describe("first and second handoff", () => {
  it("sets exactly 02's cookie on a verified Continue, then skips with a 302", async () => {
    const s = await setup();
    const cookie = await firstHandoff(s);
    expect(cookie).toContain(`.${(await deviceKeyFingerprint(s.phone.dk)).replace(/-/g, "")}.${s.w.clock.now}.`);
    expect(s.w.audit.at(-1)!.detail).toMatchObject({ consent: "explicit" });
    s.w.clock.now += 60;
    const res = await get(s, await handoffQuery(s), { Cookie: cookie });
    expect(res.status).toBe(302);
    expect(res.headers.get("Set-Cookie")).toBeNull();
    expect(res.headers.get("Location")!.startsWith(`${APP_CALLBACK}?state=${STATE}&jwe=`)).toBe(true);
    expect(s.w.audit.at(-1)).toMatchObject({ action: "handoff.issued", detail: { consent: "remembered" } });
  });

  it("Cancel sets no cookie and does not clear an existing one", async () => {
    const s = await setup();
    const cookie = await firstHandoff(s);
    const res = await post(s, await formFromPage(await get(s, await handoffQuery(s, { state: "YW5vdGhlci1zdGF0ZS1mb3ItY2FuY2Vs" })), "cancel"), { Cookie: cookie });
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  it("remembers consent on a dev build too", async () => {
    const s = await setup();
    const dev = { build: "dev", redirect: "yaranapp://auth/callback" };
    const res = await post(s, await formFromPage(await get(s, await handoffQuery(s, dev)), "continue"));
    const cookie = res.headers.get("Set-Cookie")!.split(";")[0]!;
    expect((await get(s, await handoffQuery(s, dev), { Cookie: cookie })).status).toBe(302);
  });
});

describe("the page still shows", () => {
  it("for a foreign app's signature, whose Continue sets no cookie", async () => {
    const s = await setup();
    const cookie = await firstHandoff(s);
    const foreign = await makePhone();
    const page = await get(s, await handoffQuery(s, {}, foreign.device.privateKey), { Cookie: cookie });
    expect(page.status).toBe(200);
    expect((await post(s, await formFromPage(page, "continue"))).headers.get("Set-Cookie")).toBeNull();
  });

  it("for a signature over another host, pk, state or dts", async () => {
    const s = await setup();
    const cookie = await firstHandoff(s);
    const other = await makePhone();
    const now = String(s.w.clock.now);
    const cases = [
      await signDevice(s.phone.device.privateKey, "other.example.com", s.phone.pk, STATE, now),
      await signDevice(s.phone.device.privateKey, CP_HOST, other.pk, STATE, now),
      await signDevice(s.phone.device.privateKey, CP_HOST, s.phone.pk, "b3RoZXItc3RhdGUtdmFsdWUtaGVyZQ", now),
      await signDevice(s.phone.device.privateKey, CP_HOST, s.phone.pk, STATE, String(s.w.clock.now - 1)),
    ];
    for (const dsig of cases) expect((await get(s, await handoffQuery(s, { dsig }), { Cookie: cookie })).status).toBe(200);
  });

  it("for a revoked device, even when another user holds the key unrevoked", async () => {
    const s = await setup();
    const cookie = await firstHandoff(s);
    await revokeRow(s.w, s.user.id, s.phone.dk, true);
    const other = await seedUser(s.w.ctx.db, "grace-revoked@example.org");
    await revokeRow(s.w, other.id, s.phone.dk, false);
    expect((await get(s, await handoffQuery(s), { Cookie: cookie })).status).toBe(200);
  });

  it("for a cookie naming another device key, whose Continue replaces it", async () => {
    const s = await setup();
    const cookie = await firstHandoff(s);
    s.phone = await makePhone();
    const page = await get(s, await handoffQuery(s), { Cookie: cookie });
    expect(page.status).toBe(200);
    const set = (await post(s, await formFromPage(page, "continue"), { Cookie: cookie })).headers.get("Set-Cookie")!;
    expect(set).toContain((await deviceKeyFingerprint(s.phone.dk)).replace(/-/g, ""));
  });

  it("after a DATA_KEY rotation (stale kv) or a tampered MAC, without an error or a clear", async () => {
    const s = await setup();
    const cookie = await firstHandoff(s);
    const tampered = cookie.replace(/.$/, (c) => (c === "A" ? "B" : "A"));
    const t = await get(s, await handoffQuery(s), { Cookie: tampered });
    expect(t.status).toBe(200);
    expect(t.headers.get("Set-Cookie")).toBeNull();
    // Rotate DATA_KEY: the consent MAC key's version moves on, so the old cookie is stale.
    const original = s.w.env;
    s.w.env = { ...original, DATA_KEY_PREVIOUS: original.DATA_KEY, DATA_KEY: freshDataKey() };
    try {
      expect((await get(s, await handoffQuery(s), { Cookie: cookie })).status).toBe(200);
    } finally {
      s.w.env = original;
      await s.w.ctx.db.prepare("DELETE FROM settings WHERE key = 'data_key_state'").run();
      resetKeyRingCache();
    }
  });

  it("not at all for a stale dts: that is handoff_timestamp_skewed with server_time", async () => {
    const s = await setup();
    const cookie = await firstHandoff(s);
    const res = await get(s, await handoffQuery(s, { dts: String(s.w.clock.now - 301) }), { Cookie: cookie });
    expect(res.status).toBe(302);
    expect(Object.fromEntries(callbackParams(res))).toEqual({ state: STATE, error: "handoff_timestamp_skewed", server_time: String(s.w.clock.now) });
  });

  it("not at all for a malformed dk or dsig: redirected when the callback is valid, 400 otherwise", async () => {
    const s = await setup();
    const cookie = await firstHandoff(s);
    expect(callbackParams(await get(s, await handoffQuery(s, { dk: `A${s.phone.dk.slice(1)}` }), { Cookie: cookie })).get("error")).toBe("handoff_device_key_invalid");
    expect(callbackParams(await get(s, await handoffQuery(s, { dsig: "x".repeat(85) }), { Cookie: cookie })).get("error")).toBe("handoff_signature_malformed");
    const bare = await get(s, await handoffQuery(s, { dsig: "x".repeat(85), redirect: "https://evil.example/cb" }), { Cookie: cookie });
    expect(bare.status).toBe(400);
    expect(((await bare.json()) as { error: { code: string } }).error.code).toBe("handoff_request_invalid");
  });

  it("and a POST carrying dts and dsig gains nothing over an unverified GET", async () => {
    const s = await setup();
    const foreign = await makePhone();
    const form = await formFromPage(await get(s, await handoffQuery(s, {}, foreign.device.privateKey)), "continue");
    form.set("dts", String(s.w.clock.now));
    form.set("dsig", await signDevice(s.phone.device.privateKey, CP_HOST, s.phone.pk, STATE, String(s.w.clock.now)));
    const res = await post(s, form);
    expect(res.status).toBe(303);
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });
});

/** Runs the module's skip decision with the fixture's key, kv, host and clock. */
async function decide(w: TestWorld, o: { cookie: string | null; host: string; now: number; kv: number; verified: boolean }): Promise<boolean> {
  w.clock.now = o.now;
  w.ctx.dataKey.macKey = async () => ({ kv: o.kv, key: fromHex(rememberedFx.key_hex) });
  const req = new Request("https://x/", { headers: o.cookie === null ? {} : { Cookie: `${CONSENT_COOKIE_NAME}=${o.cookie}` } });
  const q = { dk: devFpFx.cases[0]!.dk } as HandoffGet;
  return rememberedConsent(w.ctx, req, o.host, q, o.verified);
}

describe("fixtures/handoff/remembered-consent.json (side: worker)", () => {
  it("uses the device key whose fingerprint the fixture names", () => expect(devFpFx.cases[0]!.fp24).toBe(rememberedFx.dk_fp24));
  for (const row of rememberedFx.rows.filter((r) => r.side === "worker")) {
    it(row.name, async () => {
      const s = await setup();
      if (row.device_revoked) await revokeRow(s.w, s.user.id, devFpFx.cases[0]!.dk, true);
      // dts_fresh is false only on yaran rows here: the Worker refuses a stale dts before deciding.
      expect(row.dts_fresh).toBe(true);
      const skip = await decide(s.w, { cookie: row.cookie, host: rememberedFx.host, now: rememberedFx.now, kv: rememberedFx.current_kv, verified: row.verified });
      // D1 storage is shared by the whole file; later cases must not see this revocation.
      await s.w.ctx.db.prepare("DELETE FROM devices WHERE device_key_fingerprint = ?").bind(devFpFx.cases[0]!.fingerprint).run();
      expect(skip ? "skip" : "consent_page").toBe(row.expect);
      // The route sets the cookie on Continue exactly when the GET verified (handoff-route.ts).
      expect(row.verified).toBe(row.continue_sets_cookie);
      expect(row.cancel_sets_cookie).toBe(false);
    });
  }
});

describe("fixtures/handoff/consent-cookie.json verify cases", () => {
  for (const c of cookieFx.verify_cases) {
    it(`${c.name} → ${c.expect_reason ?? "verifies"}`, async () => {
      const s = await setup();
      expect(await decide(s.w, { cookie: c.value, host: c.host, now: c.now, kv: c.current_kv, verified: true })).toBe(c.expect_reason === null);
    });
  }
});
