/**
 * End-to-end tests of W16/W16b through the fake pipeline: the sealed round trip, the
 * consent page, Cancel, csrf binding, the Origin rule, the G1 cookie field, refusals,
 * fragment mode and the response headers.
 *
 * <module-headers:begin>
 * Uses:
 * test/sessions/handoff-route.test.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── test/helpers/worker.ts
 * ├── test/phase06/fakes.ts
 * └── test/sessions/handoff-helpers.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test in cloud/worker (workerd, or Node for test/provisioning))
 * <module-headers:end>
 */
import { openHandoff, validate } from "@yaran/protocol";
import { errorCode } from "../helpers/worker.ts";
import { describe, expect, it } from "vitest";
import { APP_CALLBACK, CP_HOST } from "../phase06/fakes.ts";
import { callbackParams, formFromPage, get, handoffQuery, makePhone, post, setup, STATE, type Setup } from "./handoff-helpers.ts";

const CHROME_ANDROID = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";
const SAFARI_IOS = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";

async function consentFlow(s: Setup, decision: "continue" | "cancel", o: Record<string, string | null> = {}, headers: Record<string, string> = {}) {
  const page = await get(s, await handoffQuery(s, o), headers);
  expect(page.status).toBe(200);
  return post(s, await formFromPage(page, decision), headers);
}

async function open(s: Setup, res: Response) {
  const p = callbackParams(res);
  return openHandoff({
    jwe: p.get("jwe")!,
    recipientPrivateKey: s.phone.ecdh.privateKey,
    recipientPk: s.phone.pk,
    expectedHost: CP_HOST,
    expectedState: STATE,
    expectedKind: "control_plane",
    now: s.w.clock.now,
  });
}

describe("W16/W16b round trip", () => {
  it("seals the Access JWT to the phone's key and answers 303 to the exact callback", async () => {
    const s = await setup();
    const res = await consentFlow(s, "continue");
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")!.startsWith(`${APP_CALLBACK}?state=${STATE}&jwe=`)).toBe(true);
    const opened = await open(s, res);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(validate("HandoffPayload", opened.payload).valid).toBe(true);
    expect(opened.payload).toEqual({ v: 1, kind: "control_plane", host: CP_HOST, jwt: s.jwt, email: s.user.email, exp: s.w.clock.now + 3600, iat: s.w.clock.now });
    expect(s.w.audit.map((a) => a.action)).toEqual(["handoff.issued"]);
    expect(s.w.audit[0]!.detail).toMatchObject({ consent: "explicit" });
  });

  it("sets the 303's headers", async () => {
    const s = await setup();
    const res = await consentFlow(s, "continue");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Pragma")).toBe("no-cache");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("puts state and jwe after # in fragment mode", async () => {
    const s = await setup();
    const res = await consentFlow(s, "continue", { mode: "fragment" });
    expect(res.headers.get("Location")!.startsWith(`${APP_CALLBACK}#state=${STATE}&jwe=`)).toBe(true);
    expect((await open(s, res)).ok).toBe(true);
  });

  it("carries the CF_Authorization cookie only when the request had one", async () => {
    const s = await setup();
    const withCookie = await open(s, await consentFlow(s, "continue", {}, { Cookie: "a=b; CF_Authorization=cookie-jwt-value" }));
    expect(withCookie.ok && withCookie.payload.cookie).toBe("cookie-jwt-value");
    const without = await open(s, await consentFlow(s, "continue"));
    expect(without.ok && "cookie" in without.payload).toBe(false);
  });

  it("answers Cancel with handoff_declined and audits it", async () => {
    const s = await setup();
    const res = await consentFlow(s, "cancel");
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe(`${APP_CALLBACK}?state=${STATE}&error=handoff_declined`);
    expect(res.headers.get("Set-Cookie")).toBeNull();
    expect(s.w.audit.map((a) => a.action)).toEqual(["handoff.declined"]);
  });
});

describe("consent page", () => {
  it("names device, platform, host and email as chips and focuses Continue", async () => {
    const s = await setup();
    const res = await get(s, await handoffQuery(s), { "User-Agent": CHROME_ANDROID });
    const html = await res.text();
    for (const name of ["Ada&#39;s Pixel", "Android", CP_HOST, s.user.email]) expect(html).toContain(`>${name}</code>`);
    expect(html).toMatch(/<button[^>]*value="continue"[^>]* autofocus>Continue<\/button>/);
    expect(html).toContain('<html lang="en">');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("development build");
    expect(html).not.toContain('name="dsig"');
    expect(html).not.toContain('name="dts"');
  });

  it("reads iOS from Safari and omits an unrecognised platform", async () => {
    const s = await setup();
    expect(await (await get(s, await handoffQuery(s), { "User-Agent": SAFARI_IOS })).text()).toContain(">iOS</code>");
    const plain = await (await get(s, await handoffQuery(s), { "User-Agent": "curl/8.0" })).text();
    expect(plain).not.toContain('aria-label="Platform"');
  });

  it("carries the CSP and Referrer-Policy the form POST needs", async () => {
    const s = await setup();
    const res = await get(s, await handoffQuery(s));
    expect(res.headers.get("Referrer-Policy")).toBe("same-origin");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const csp = res.headers.get("Content-Security-Policy")!;
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'self' https://yaran.example;");
    expect(csp).not.toMatch(/script-src/);
  });

  it("warns on a dev build and allows the custom scheme as form-action", async () => {
    const s = await setup();
    const res = await get(s, await handoffQuery(s, { build: "dev", redirect: "yaranapp://auth/callback" }));
    expect(await res.text()).toContain("development build");
    expect(res.headers.get("Content-Security-Policy")).toContain("form-action 'self' yaranapp:;");
  });
});

describe("csrf and Origin", () => {
  it("refuses a reused csrf", async () => {
    const s = await setup();
    const form = await formFromPage(await get(s, await handoffQuery(s)), "continue");
    expect((await post(s, form)).status).toBe(303);
    const again = await post(s, form);
    expect(callbackParams(again).get("error")).toBe("handoff_request_invalid");
  });

  it("refuses an expired csrf", async () => {
    const s = await setup();
    const form = await formFromPage(await get(s, await handoffQuery(s)), "continue");
    s.w.clock.now += 601;
    expect(callbackParams(await post(s, form)).get("error")).toBe("handoff_request_invalid");
  });

  it("refuses a csrf bound to another state, pk or dk", async () => {
    const s = await setup();
    const p2 = await makePhone();
    for (const [k, v] of [["state", "b3RoZXItc3RhdGUtdmFsdWUtaGVyZQ"], ["pk", p2.pk], ["dk", p2.dk]] as const) {
      const form = await formFromPage(await get(s, await handoffQuery(s)), "continue");
      form.set(k, v);
      const res = await post(s, form);
      expect(res.status).toBe(303);
      expect(callbackParams(res).get("error")).toBe("handoff_request_invalid");
    }
  });

  it("passes the page's own Origin and refuses Origin: null", async () => {
    const s = await setup();
    const form = await formFromPage(await get(s, await handoffQuery(s)), "continue");
    // 04's pipeline refuses a foreign Origin on every form post before the handler runs.
    const refused = await post(s, form, { Origin: "null" });
    expect([refused.status, await errorCode(refused)]).toEqual([403, "origin_mismatch"]);
    expect((await post(s, form)).headers.get("Location")).toContain("&jwe=");
  });
});

describe("refusals", () => {
  it.each([
    ["a bad redirect", { redirect: "https://evil.example/auth/callback" }],
    ["a release request naming the custom scheme", { redirect: "yaranapp://auth/callback" }],
  ])("answers %s with 400 and no Location", async (_n, o) => {
    const s = await setup();
    const res = await get(s, await handoffQuery(s, o));
    expect(res.status).toBe(400);
    expect(res.headers.get("Location")).toBeNull();
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("handoff_request_invalid");
  });

  it("redirects a bad point when the callback is valid", async () => {
    const s = await setup();
    const res = await get(s, await handoffQuery(s, { pk: s.phone.pk.slice(0, 86) }));
    expect(res.status).toBe(302);
    expect(callbackParams(res).get("error")).toBe("handoff_request_invalid");
  });

  it("serves an HTML error page to a browser navigation", async () => {
    const s = await setup();
    const res = await get(s, await handoffQuery(s, { redirect: "https://evil.example/cb" }), { Accept: "text/html" });
    expect(res.status).toBe(400);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(await res.text()).toContain(">handoff_request_invalid</code>");
  });

  it("refuses a request with no Access JWT", async () => {
    const s = await setup();
    s.jwt = "";
    const res = await get(s, await handoffQuery(s));
    expect(res.status).toBe(401);
  });

  it("rate-limits Continue per JWT sub with Retry-After", async () => {
    const s = await setup();
    for (let i = 0; i < 20; i++) await consentFlow(s, "continue");
    const res = await consentFlow(s, "continue");
    expect(callbackParams(res).get("error")).toBe("rate_limited");
    expect(res.headers.get("Retry-After")).toBe("60");
  });
});
