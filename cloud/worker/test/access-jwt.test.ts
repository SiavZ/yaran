/**
 * Access JWT verification against a JWKS served by msw at the team's certs URL.
 *
 * <module-headers:begin>
 * Uses:
 * test/access-jwt.test.ts
 * ├── src/auth/access-jwt.ts
 * ├── src/http/responses.ts
 * ├── test/helpers/access.ts
 * ├── test/helpers/seed.ts
 * ├── test/helpers/worker.ts
 * └── test/setup.ts
 * External: msw, vitest
 *
 * Used by: entry point (vitest inside workerd, via npm test in cloud/worker)
 * <module-headers:end>
 */
import { http, HttpResponse } from "msw";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetJwksCache, verifyAccessJwt } from "../src/auth/access-jwt.ts";
import { HttpError } from "../src/http/responses.ts";
import { forgedJwt, mintJwt, mintServiceToken, serveJwks } from "./helpers/access.ts";
import { AUD, closeSetup, CP_HOST, NOW, seedUser, TEAM } from "./helpers/seed.ts";
import { errorCode, handler } from "./helpers/worker.ts";
import { network } from "./setup.ts";

const call = handler();
const me = (jwt: string | null) => call(new Request(`https://${CP_HOST}/v1/me`, {
  headers: { "Yaran-Protocol": "1", ...(jwt === null ? {} : { "Cf-Access-Jwt-Assertion": jwt }) },
}));
let email = "";

beforeAll(async () => {
  await closeSetup();
  email = (await seedUser()).email;
});
beforeEach(() => resetJwksCache());
afterEach(() => vi.useRealTimers());

describe("valid tokens", () => {
  it("accepts a user token from the header only", async () => {
    serveJwks();
    const res = await me(await mintJwt({ email }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ identity: "user", user: email });
    const cookieOnly = await call(new Request(`https://${CP_HOST}/v1/me`, {
      headers: { "Yaran-Protocol": "1", Cookie: `CF_Authorization=${await mintJwt({ email })}` },
    }));
    expect(await errorCode(cookieOnly)).toBe("unauthenticated");
  });
  it("tolerates clock skew within jwt_clock_tolerance_s", async () => {
    serveJwks();
    expect((await me(await mintJwt({ email, exp: NOW - 30 }))).status).toBe(200);
    expect((await me(await mintJwt({ email, nbf: NOW + 30 }))).status).toBe(200);
  });
});

describe("refusals", () => {
  const cases: [string, () => Promise<string>, string][] = [
    ["wrong aud", () => mintJwt({ email, aud: "b".repeat(64) }), "unauthenticated"],
    ["wrong iss", () => mintJwt({ email, iss: "https://other.cloudflareaccess.com" }), "unauthenticated"],
    ["iss with a trailing slash", () => mintJwt({ email, iss: `https://${TEAM}/` }), "unauthenticated"],
    ["expired", () => mintJwt({ email, exp: NOW - 61 }), "unauthenticated"],
    ["nbf in the future", () => mintJwt({ email, nbf: NOW + 61 }), "unauthenticated"],
    ["alg none", async () => forgedJwt("none"), "unauthenticated"],
    ["alg HS256", async () => forgedJwt("HS256"), "unauthenticated"],
    ["not an app token", () => mintJwt({ email, type: "org" }), "unauthenticated"],
    ["missing email", () => mintJwt({ email: null }), "unauthenticated"],
    ["blank email", () => mintJwt({ email: "  " }), "unauthenticated"],
    ["empty sub", () => mintJwt({ email, sub: "" }), "unauthenticated"],
    ["service token", mintServiceToken, "service_token_rejected"],
  ];
  it.each(cases)("%s", async (_name, mint, code) => {
    serveJwks();
    const res = await me(await mint());
    expect(await errorCode(res)).toBe(code);
  });

  it("refuses an unknown kid after refetching the key set once the cooldown passed", async () => {
    const jwks = serveJwks();
    vi.useFakeTimers({ toFake: ["Date"] });
    expect((await me(await mintJwt({ email }))).status).toBe(200);
    expect(jwks.fetches).toBe(1);
    vi.setSystemTime(Date.now() + 31_000);
    expect(await errorCode(await me(await mintJwt({ email, kid: "rotated-away" })))).toBe("unauthenticated");
    expect(jwks.fetches).toBe(2);
  });

  it("fails closed when the JWKS is unreachable or broken", async () => {
    for (const reply of [() => HttpResponse.error(), () => new HttpResponse("down", { status: 500 }), () => HttpResponse.json({ nope: 1 })]) {
      resetJwksCache();
      network.use(http.get(`https://${TEAM}/cdn-cgi/access/certs`, reply));
      const res = await me(await mintJwt({ email }));
      expect(res.status).toBe(503);
      expect(await errorCode(res)).toBe("identity_unavailable");
    }
  });

  it("answers 401 with no JWT and logs a warning naming the route", async () => {
    const spy = vi.spyOn(console, "log");
    expect(await errorCode(await me(null))).toBe("unauthenticated");
    const lines = spy.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>);
    expect(lines).toContainEqual(expect.objectContaining({ level: "warn", event: "access_jwt_missing", route: "/v1/me" }));
    spy.mockRestore();
  });
});

describe("team domain rule", () => {
  it.each(["evil.example.com", "acme.cloudflareaccess.com.evil.net", "a/b.cloudflareaccess.com", ""])("refuses %j without fetching", async (team) => {
    const jwks = serveJwks(team || "x.invalid");
    const req = new Request("https://x/", { headers: { "Cf-Access-Jwt-Assertion": await mintJwt() } });
    await expect(verifyAccessJwt(req, { teamDomain: team, aud: AUD, clockToleranceS: 60, now: NOW })).rejects.toMatchObject({ code: "identity_unavailable" });
    expect(jwks.fetches).toBe(0);
  });
  it("accepts the FedRAMP form", async () => {
    const team = "acme.fed.cloudflareaccess.com";
    serveJwks(team);
    const req = new Request("https://x/", { headers: { "Cf-Access-Jwt-Assertion": await mintJwt({ iss: `https://${team}` }) } });
    await expect(verifyAccessJwt(req, { teamDomain: team, aud: AUD, clockToleranceS: 60, now: NOW })).resolves.toMatchObject({ email: "user@example.com" });
    expect(HttpError).toBeDefined();
  });
});
