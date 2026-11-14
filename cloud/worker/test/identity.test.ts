/**
 * Identity: first-sight provisioning, slugs, disabled users, email case folding and the
 * last-seen throttle.
 *
 * <module-headers:begin>
 * Uses:
 * test/identity.test.ts
 * ├── src/auth/identity.ts
 * ├── src/db/users.ts
 * ├── src/provisioning/naming.ts
 * ├── test/helpers/access.ts
 * ├── test/helpers/seed.ts
 * └── test/helpers/worker.ts
 * External: cloudflare:test, vitest
 *
 * Used by: entry point (vitest, via npm test in cloud/worker (workerd, or Node for test/provisioning))
 * <module-headers:end>
 */
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { pickSlug, resolveUser } from "../src/auth/identity.ts";
import { deriveUserSlug } from "../src/provisioning/naming.ts";
import { getUserByEmail, touchUserSeen } from "../src/db/users.ts";
import { mintJwt, serveJwks } from "./helpers/access.ts";
import { closeSetup, CP_HOST, NOW, seedUser } from "./helpers/seed.ts";
import { errorCode, handler } from "./helpers/worker.ts";

beforeAll(() => closeSetup());
const claims = (email: string) => ({ email, sub: "s", exp: NOW + 60 });

describe("slugs", () => {
  it("derives 05's user slug", async () => {
    expect(await deriveUserSlug("Ada.Lovelace+test@example.com")).toBe("ada-lovelace-test");
    expect(await deriveUserSlug("Zoë@example.com")).toBe("zoe");
    expect(await deriveUserSlug("a-very-long-local-part-indeed@x.com")).toBe("a-very-long-local-pa");
    expect(await deriveUserSlug("+++@example.com")).toMatch(/^u[0-9a-f]{6}$/);
  });
  it("picks -2 … -99, then a hex suffix", () => {
    expect(pickSlug("ada", new Set())).toBe("ada");
    expect(pickSlug("ada", new Set(["ada", "ada-2"]))).toBe("ada-3");
    const all = new Set(["ada", ...Array.from({ length: 98 }, (_, i) => `ada-${i + 2}`)]);
    expect(pickSlug("ada", all)).toMatch(/^ada-[0-9a-f]{4}$/);
  });
});

describe("resolveUser", () => {
  it("creates a plain user on first sight, folding the email's case", async () => {
    const u = await resolveUser(env.DB, claims("  New.Person@Example.COM "), true, NOW);
    expect(u).toMatchObject({ email: "new.person@example.com", role: "user", status: "active", slug: "new-person" });
    const again = await resolveUser(env.DB, claims("new.person@example.com"), true, NOW);
    expect(again.id).toBe(u.id);
    const clash = await resolveUser(env.DB, claims("new.person@other.org"), true, NOW);
    expect(clash.slug).toBe("new-person-2");
  });
  it("does not create users while setup is open", async () => {
    await expect(resolveUser(env.DB, claims("early@example.com"), false, NOW)).rejects.toMatchObject({ code: "setup_incomplete" });
  });
  it("refuses a disabled user with 403 user_disabled", async () => {
    const u = await seedUser({ disabled: true });
    serveJwks();
    const res = await handler()(new Request(`https://${CP_HOST}/v1/me`, {
      headers: { "Yaran-Protocol": "1", "Cf-Access-Jwt-Assertion": await mintJwt({ email: u.email }) },
    }));
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("user_disabled");
  });
  it("stamps last_seen_at at most once per five minutes", async () => {
    const u = await seedUser();
    expect(await touchUserSeen(env.DB, u.id, NOW + 10)).toBe(false);
    expect(await touchUserSeen(env.DB, u.id, NOW + 300)).toBe(true);
    await resolveUser(env.DB, claims(u.email), true, NOW + 400);
    expect((await getUserByEmail(env.DB, u.email))!.last_seen_at).toBe(NOW + 300);
    await resolveUser(env.DB, claims(u.email), true, NOW + 600);
    expect((await getUserByEmail(env.DB, u.email))!.last_seen_at).toBe(NOW + 600);
  });
});
