/**
 * The whole wizard through its routes against the fake Cloudflare: code, token, org, zone,
 * Access, domain, IdP, keys, claim; plus the refusals on the way (wrong code, lockout,
 * missing secrets, foreign origin, missing permission) and setup staying closed afterwards.
 *
 * <module-headers:begin>
 * Uses:
 * test/setup-flow.test.ts
 * ├── src/admin/settings-store.ts
 * ├── src/admin/setup-settings.ts
 * ├── src/setup/routes.ts
 * ├── src/setup/steps/common.ts
 * └── test/helpers/deps.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test in cloud/worker (workerd, or Node for test/provisioning))
 * <module-headers:end>
 */
import { describe, expect, test } from "vitest";
import { readKey } from "../src/admin/settings-store.ts";
import { API_TOKEN_AAD, API_TOKEN_KEY } from "../src/admin/setup-settings.ts";
import { loadRecord } from "../src/setup/steps/common.ts";
import { SETUP_ROUTES } from "../src/setup/routes.ts";
import { dispatch, SETUP_CODE, world, type TestWorld } from "./helpers/deps.ts";

const WD = "https://yaran-cloud.acme.workers.dev";

function client(w: TestWorld, ip?: string) {
  let cookie = "";
  const send = async (method: string, path: string, form?: Record<string, string>, origin = WD) => {
    const headers: Record<string, string> = { Cookie: cookie, Origin: origin };
    if (ip) headers["CF-Connecting-IP"] = ip;
    const init: RequestInit = { headers };
    if (form) init.body = new URLSearchParams(form);
    const res = await dispatch(SETUP_ROUTES, w, method, path.startsWith("http") ? path : WD + path, init);
    const set = res.headers.get("Set-Cookie");
    if (set) cookie = set.split(";")[0]!;
    return { res, text: await res.text() };
  };
  return { get: (p: string) => send("GET", p), post: (p: string, f: Record<string, string> = {}, origin?: string) => send("POST", p, f, origin) };
}

describe("the setup wizard end to end", () => {
  test("walks every step in order and closes setup for good", async () => {
    const w = await world();
    const c = client(w);
    expect((await c.get("/setup")).text).toContain("Setup code");
    const wrong = await c.post("/setup/code", { code: "nope" });
    expect(wrong.res.status).toBe(401);
    expect(wrong.text).toContain("setup_code_invalid");
    expect((await c.post("/setup/code", { code: SETUP_CODE })).res.status).toBe(303);
    expect((await c.get("/setup")).text).toContain("Open the token template");
    expect((await c.post("/setup/token", { token: "", admin_email: "Ada@Example.org" })).res.status).toBe(303);
    expect((await loadRecord(w.db)).step).toBe("org");
    const sealed = await readKey<string>(w.db, API_TOKEN_KEY);
    expect(sealed).toMatch(/^k1\./);
    expect(await w.deps.sealer.open("cf_api_token", API_TOKEN_AAD, sealed!)).toBe(w.env.CF_API_TOKEN);
    await c.post("/setup/org", { action: "check" });
    expect((await c.get("/setup")).text).toContain("example.org");
    await c.post("/setup/zone", { zone_id: "z1", label: "cp" });
    await c.post("/setup/access");
    await c.post("/setup/domain", { action: "attach" });
    expect(w.cf.calls.findIndex((x) => x === "POST /accounts/acc1/access/apps")).toBeLessThan(w.cf.calls.findIndex((x) => x === "PUT /accounts/acc1/workers/domains"));
    const blocked = await c.post("/setup/idp", { action: "finish" });
    expect(blocked.text).toContain("Add at least one sign-in method");
    await c.post("/setup/idp", { action: "onetimepin" });
    await c.post("/setup/idp", { action: "finish" });
    await c.post("/setup/keys");
    expect((await loadRecord(w.db)).step).toBe("claim");
    const link = (await c.post("/setup/claim-link")).text.match(/https:\/\/cp\.example\.org\/setup\/claim\?c=[\w%-]+/)![0];

    const anon = client(w);
    expect((await anon.get(link)).res.status).toBe(403);
    w.identity = { email: "ada@example.org", sub: "s" };
    const done = await anon.get(link);
    expect(done.res.status).toBe(200);
    expect(done.text).toContain("Setup is closed for good");
    expect(done.text).toContain('data-selftest="machine"');
    expect(await readKey(w.db, "setup_state")).toBe("closed");
    expect(await readKey(w.db, "control_plane_host")).toBe("cp.example.org");
    expect(w.cf.subdomain.enabled).toBe(false);
    // Once closed, workers.dev is not served at all (D19), and /setup is gone on the control plane.
    expect((await c.get("/setup")).res.status).toBe(421);
    expect((await anon.get(link)).res.status).toBe(410);
  });

  test("a token missing a permission is not stored and the page names the permission", async () => {
    const w = await world();
    w.cf.fault("GET /accounts/acc1/access/identity_providers", "auth");
    const c = client(w);
    await c.post("/setup/code", { code: SETUP_CODE });
    const r = await c.post("/setup/token", { admin_email: "ada@example.org" });
    expect(r.res.status).toBe(502);
    expect(r.text).toContain("cloudflare_permission_denied");
    expect(r.text).toContain("Access: Organizations, Identity Providers, and Groups Edit");
    expect(await readKey(w.db, "cf_api_token_enc")).toBeUndefined();
  });

  // Five tries per 15 minutes per address: a brute force has to wait between bursts.
  const later = (w: TestWorld) => (w.clock.now = new Date(w.clock.now.getTime() + 15 * 60 * 1000));

  test("brute force locks the address it came from, and the page says why", async () => {
    const w = await world();
    // The auth bucket's binding counts in real time; its D1 fallback follows the test clock.
    w.env = { ...w.env, RL_AUTH: undefined } as unknown as typeof w.env;
    const c = client(w, "198.51.100.7");
    for (let i = 0; i < 19; i++) {
      if (i > 0 && i % 5 === 0) later(w);
      expect((await c.post("/setup/code", { code: `x${i}` })).res.status).toBe(401);
    }
    const locked = await c.post("/setup/code", { code: "x19" });
    expect(locked.res.status).toBe(403);
    expect(locked.text).toContain("setup_locked");
    expect(locked.text).toContain("20 wrong setup codes from your address");
    expect((await c.get("/setup")).text).toContain("setup_locked");
    expect((await c.post("/setup/code", { code: SETUP_CODE })).res.status).toBe(403);
    expect((await client(w, "198.51.100.8").post("/setup/code", { code: SETUP_CODE })).res.status).toBe(303);
  });

  test("a stranger guessing from many addresses cannot lock out the admin", async () => {
    const w = await world();
    for (let ip = 0; ip < 8; ip++) {
      const stranger = client(w, `192.0.2.${ip + 1}`);
      for (let i = 0; i < 5; i++) await stranger.post("/setup/code", { code: `guess-${ip}-${i}` });
    }
    const admin = client(w, "198.51.100.20");
    expect((await admin.post("/setup/code", { code: SETUP_CODE })).res.status).toBe(303);
  });

  test("the sixth try in 15 minutes is refused with the reason and the wait", async () => {
    const w = await world();
    const c = client(w, "198.51.100.9");
    for (let i = 0; i < 5; i++) await c.post("/setup/code", { code: `x${i}` });
    const limited = await c.post("/setup/code", { code: SETUP_CODE });
    expect(limited.res.status).toBe(429);
    expect(limited.res.headers.get("Retry-After")).toBe("900");
    expect(limited.text).toContain("5 setup codes per 15 minutes");
    expect(limited.text).toContain("15 minutes");
  });

  test("missing or weak secrets are explained and nothing else happens", async () => {
    const w = await world();
    w.env = { ...w.env, SETUP_CODE: "short", DATA_KEY: undefined };
    const r = await client(w).get("/setup");
    expect(r.res.status).toBe(503);
    expect(r.text).toContain("shorter than 24 characters");
    expect(r.text).toContain("DATA_KEY secret is not set");
  });

  test("a form posted from another origin is refused", async () => {
    const w = await world();
    expect((await client(w).post("/setup/code", { code: SETUP_CODE }, "https://evil.example")).res.status).toBe(403);
  });

  test("steps need the setup cookie", async () => {
    const w = await world();
    const r = await client(w).post("/setup/token", { admin_email: "ada@example.org" });
    expect(r.res.status).toBe(303);
    expect((await loadRecord(w.db)).step).toBe("locked");
  });
});
