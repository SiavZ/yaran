/**
 * Rate limiting: the binding tier (Miniflare simulates `ratelimits`), the D1 fallback when
 * a binding is absent, fixed-window rollover, the per-address setup limits and lockout,
 * and Retry-After.
 *
 * <module-headers:begin>
 * Uses:
 * test/rate-limit.test.ts
 * ├── src/db/client.ts
 * ├── src/http/responses.ts
 * ├── src/security/rate-limit.ts
 * ├── test/helpers/app.ts
 * ├── test/helpers/seed.ts
 * └── test/helpers/worker.ts
 * External: cloudflare:test, vitest
 *
 * Used by: entry point (vitest, via npm test in cloud/worker (workerd, or Node for test/provisioning))
 * <module-headers:end>
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { one } from "../src/db/client.ts";
import { HttpError } from "../src/http/responses.ts";
import { hitBucket, purgeRateCounters, setupAttempt, setupFailure, SETUP_LIMITS, strictHit } from "../src/security/rate-limit.ts";
import { appCtx } from "./helpers/app.ts";
import { closeSetup, CP_HOST, NOW } from "./helpers/seed.ts";
import { handler } from "./helpers/worker.ts";

const refusal = async (p: Promise<unknown>) => p.then(() => null, (e: HttpError) => e);

describe("binding tier", () => {
  it("refuses past the binding's limit with 429 and Retry-After", async () => {
    const ctx = appCtx();
    for (let i = 0; i < 20; i++) await hitBucket(ctx, "auth", "203.0.113.1");
    const err = await refusal(hitBucket(ctx, "auth", "203.0.113.1"));
    expect(err).toMatchObject({ code: "rate_limited", headers: { "Retry-After": "60" } });
    await hitBucket(ctx, "auth", "203.0.113.2");
    expect(await one(env.DB, "SELECT 1 FROM rate_counters WHERE key LIKE 'rl:auth:%'")).toBeNull();
  });
});

describe("D1 fallback", () => {
  it("uses the strict counter when the binding is absent", async () => {
    const ctx = appCtx({ RL_MACHINE: undefined } as unknown as Partial<Cloudflare.Env>, NOW + 30);
    for (let i = 0; i < 120; i++) await hitBucket(ctx, "machine", "m-1");
    const err = await refusal(hitBucket(ctx, "machine", "m-1"));
    expect(err).toMatchObject({ code: "rate_limited", headers: { "Retry-After": String(60 - ((NOW + 30) % 60)) } });
  });
  it("rolls the fixed window over", async () => {
    const t = 1_800_000_000;
    expect((await strictHit(env.DB, "k", 2, 60, t)).ok).toBe(true);
    expect((await strictHit(env.DB, "k", 2, 60, t + 1)).ok).toBe(true);
    expect(await strictHit(env.DB, "k", 2, 60, t + 2)).toEqual({ ok: false, retryAfter: 60 - 2 - (t % 60) });
    expect((await strictHit(env.DB, "k", 2, 60, t + 60)).ok).toBe(true);
  });
  it("answers a pipeline request over the limit with 429 and Retry-After", async () => {
    await closeSetup();
    const call = handler();
    const noBinding = { ...env, RL_IP: undefined } as unknown as Cloudflare.Env;
    let last: Response | null = null;
    for (let i = 0; i < 301; i++) last = await call(new Request(`https://${CP_HOST}/v1/meta`, { headers: { "CF-Connecting-IP": "192.0.2.9" } }), noBinding);
    expect(last!.status).toBe(429);
    expect(Number(last!.headers.get("Retry-After"))).toBeGreaterThan(0);
  });
});

describe("setup attempts", () => {
  const WINDOW = SETUP_LIMITS.perIpWindowS;

  it("limits each address to 5 tries per 15 minutes and 30 a day, without locking", async () => {
    for (let i = 0; i < SETUP_LIMITS.perIp; i++) expect(await setupAttempt(env.DB, "ip-a", "code1", NOW)).toEqual({ kind: "ok" });
    expect(await setupAttempt(env.DB, "ip-a", "code1", NOW)).toMatchObject({ kind: "limited", reason: "window" });
    expect(await setupAttempt(env.DB, "ip-b", "code1", NOW)).toEqual({ kind: "ok" });
    let t = NOW;
    let tries = SETUP_LIMITS.perIp;
    while (tries < SETUP_LIMITS.perIpDay) {
      t += WINDOW;
      for (let i = 0; i < SETUP_LIMITS.perIp && tries < SETUP_LIMITS.perIpDay; i++, tries++) {
        expect(await setupAttempt(env.DB, "ip-a", "code1", t)).toEqual({ kind: "ok" });
      }
    }
    const dayStart = NOW - (NOW % 86_400);
    // A whole day's tries can straddle midnight; stay inside the day the test started in.
    if (t < dayStart + 86_400) {
      expect(await setupAttempt(env.DB, "ip-a", "code1", t + WINDOW)).toMatchObject({ kind: "limited", reason: "day" });
    }
    expect(await setupAttempt(env.DB, "ip-a", "code1", dayStart + 86_400 + 1)).toEqual({ kind: "ok" });
  });

  it("locks only the address that entered 20 wrong codes, until the code changes", async () => {
    for (let i = 1; i < SETUP_LIMITS.lockAfterFailures; i++) expect(await setupFailure(env.DB, "ip-a", "code1", NOW)).toEqual({ kind: "counted" });
    expect(await setupFailure(env.DB, "ip-a", "code1", NOW)).toEqual({ kind: "locked", reason: "failures" });
    expect(await setupAttempt(env.DB, "ip-a", "code1", NOW + WINDOW)).toEqual({ kind: "locked", reason: "failures" });
    expect(await setupAttempt(env.DB, "ip-b", "code1", NOW + WINDOW)).toEqual({ kind: "ok" });
    await purgeRateCounters(env.DB, NOW + 10 * 86_400);
    expect(await setupAttempt(env.DB, "ip-a", "code1", NOW + 10 * 86_400)).toEqual({ kind: "locked", reason: "failures" });
    expect(await setupAttempt(env.DB, "ip-a", "code2", NOW + 10 * 86_400)).toEqual({ kind: "ok" });
  });

  it("a stranger spreading wrong codes over many addresses cannot lock out the admin", async () => {
    let ip = 0;
    for (let n = 0; n < SETUP_LIMITS.globalFailureBackstop; n++) {
      expect(await setupAttempt(env.DB, `stranger-${ip}`, "code1", NOW)).toEqual({ kind: "ok" });
      await setupFailure(env.DB, `stranger-${ip}`, "code1", NOW);
      if (n % SETUP_LIMITS.perIp === SETUP_LIMITS.perIp - 1) ip++;
    }
    // Past the backstop a wrong code locks its address at once...
    expect(await setupFailure(env.DB, "late-stranger", "code1", NOW)).toEqual({ kind: "locked", reason: "backstop" });
    expect(await setupAttempt(env.DB, "late-stranger", "code1", NOW)).toEqual({ kind: "locked", reason: "backstop" });
    // ...while an address that has not failed can still try its code.
    expect(await setupAttempt(env.DB, "admin", "code1", NOW)).toEqual({ kind: "ok" });
  });
});
