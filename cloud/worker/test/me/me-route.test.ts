/**
 * `GET /v1/me`: schema-valid `Me`, `session_exp` from the verified JWT, caps from
 * settings and counts that exclude revoked machines and devices.
 *
 * <module-headers:begin>
 * Uses:
 * test/me/me-route.test.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/me/me-route.ts
 * ├── test/phase06/fakes.ts
 * └── test/phase06/harness.ts
 * External: vitest
 *
 * Used by: entry point (vitest in the Workers pool, via npm test in cloud/worker)
 * <module-headers:end>
 */
import { validate, type Me } from "@yaran/protocol";
import { describe, expect, it } from "vitest";
import { ME_ROUTES } from "../../src/me/me-route.ts";
import { CP_HOST, fakeJwt, makeWorld, seedMachine, seedUser } from "../phase06/fakes.ts";
import { CP_AUD, dispatch } from "../phase06/harness.ts";

describe("GET /v1/me", () => {
  it("answers Me with session_exp, caps and live counts", async () => {
    const w = await makeWorld();
    const user = await seedUser(w.ctx.db, "ada@example.org", { role: "admin" });
    await seedMachine(w.ctx.db, user, { status: "active" });
    await seedMachine(w.ctx.db, user, { name: "desk", status: "awaiting_claim" });
    await seedMachine(w.ctx.db, user, { name: "old", status: "revoked" });
    for (const revoked of [null, w.clock.now]) {
      await w.ctx.db
        .prepare(
          `INSERT INTO devices (id, user_id, install_id, platform, flavor, form_factor, push_kind, device_key, device_key_fingerprint, app_version, label, created_at, revoked_at)
           VALUES (?, ?, ?, 'ios', 'appstore', 'phone', 'none', ?, 'AAAA-AAAA-AAAA-AAAA-AAAA-AAAA', '1.0.0', 'iPhone', 0, ?)`,
        )
        .bind(crypto.randomUUID(), user.id, crypto.randomUUID(), new Uint8Array(65), revoked)
        .run();
    }
    w.settings.machine_cap_per_user = 7;
    const exp = 1_800_003_600;
    const res = await dispatch(ME_ROUTES, new Request(`https://${CP_HOST}/v1/me`, { headers: { "Cf-Access-Jwt-Assertion": fakeJwt({ email: user.email, sub: "s", exp, aud: [CP_AUD] }) } }), w.ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const me = (await res.json()) as Me;
    expect(validate("Me", me).valid).toBe(true);
    expect(me).toEqual({
      email: user.email,
      session_exp: "2027-01-15T09:00:00Z",
      role: "admin",
      user_slug: "ada",
      org: { name: "Example Org", url: `https://${CP_HOST}` },
      limits: { machines: 7, devices: 10 },
      counts: { machines: 2, devices: 1 },
    });
  });

  it("refuses a request with no Access JWT", async () => {
    const w = await makeWorld();
    expect((await dispatch(ME_ROUTES, new Request(`https://${CP_HOST}/v1/me`), w.ctx)).status).toBe(401);
  });
});
