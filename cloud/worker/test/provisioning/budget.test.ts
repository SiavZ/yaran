/**
 * Budget: Ratelimit parsing, the priority gate, blocked_until short-circuit, one write per invocation.
 *
 * <module-headers:begin>
 * Uses:
 * test/provisioning/budget.test.ts
 * ├── src/cloudflare/budget.ts
 * ├── src/cloudflare/client.ts
 * ├── src/cloudflare/errors.ts
 * └── test/provisioning/helpers/d1.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test in cloud/worker (workerd, or Node for test/provisioning))
 * <module-headers:end>
 */
import { describe, expect, it } from "vitest";
import { ApiBudget, parseRatelimit } from "../../src/cloudflare/budget.ts";
import { CfClient } from "../../src/cloudflare/client.ts";
import { CfApiError } from "../../src/cloudflare/errors.ts";
import { FakeD1 } from "./helpers/d1.ts";

describe("parseRatelimit", () => {
  it("reads r and t", () => {
    expect(parseRatelimit('"default";r=50;t=30')).toEqual({ remaining: 50, resetSeconds: 30 });
    expect(parseRatelimit('"a";q=1, "default";r=7;t=2')).toEqual({ remaining: 7, resetSeconds: 2 });
  });
  it("returns null for absent or malformed headers", () => {
    for (const h of [null, "", "garbage", '"x";r=abc;t=1', '"x";r=1']) expect(parseRatelimit(h)).toBeNull();
  });
});

function setup(row?: { remaining: number | null; reset_at: number | null; blocked_until: number | null }) {
  const db = new FakeD1();
  if (row) {
    db.sqlite.prepare("INSERT INTO cf_api_budget (id, remaining, reset_at, blocked_until, observed_at) VALUES (1, ?, ?, ?, 0)").run(row.remaining, row.reset_at, row.blocked_until);
  }
  const clock = { now: 1000 };
  const budget = new ApiBudget(db, () => clock.now, 600);
  let calls = 0;
  const c = new CfClient({
    fetch: (async () => (calls++, Response.json({ success: true, errors: [], result: null }, { headers: { ratelimit: '"d";r=900;t=100' } }))) as typeof fetch,
    token: "t",
    baseUrl: "https://api.cloudflare.com/client/v4",
    budget,
    userAgent: "t",
    sleep: async () => {},
  });
  return { db, budget, c, clock, calls: () => calls };
}

describe("ApiBudget gate", () => {
  it("lets interactive run above 20 and refuses background under the reserve", async () => {
    const s = setup({ remaining: 300, reset_at: 1200, blocked_until: null });
    await s.c.request("GET", "/x", { priority: "interactive" });
    const s2 = setup({ remaining: 300, reset_at: 1200, blocked_until: null });
    await expect(s2.c.request("GET", "/x", { priority: "background" })).rejects.toMatchObject({ kind: "rate_limited" });
    expect(s2.calls()).toBe(0);
    const s3 = setup({ remaining: 20, reset_at: 1200, blocked_until: null });
    await expect(s3.c.request("GET", "/x", { priority: "interactive" })).rejects.toBeInstanceOf(CfApiError);
  });

  it("treats a reset window as full", async () => {
    const s = setup({ remaining: 0, reset_at: 900, blocked_until: null });
    await s.c.request("GET", "/x", { priority: "background" });
    expect(s.calls()).toBe(1);
  });

  it("short-circuits a known block with no network call", async () => {
    const s = setup({ remaining: 1000, reset_at: 1200, blocked_until: 1100 });
    const err = await s.c.request("GET", "/x", { priority: "interactive" }).catch((e: CfApiError) => e);
    expect(err).toMatchObject({ kind: "rate_limited", retryAfter: 100 });
    expect(s.calls()).toBe(0);
  });

  it("records a 429's retry-after as blocked_until and writes once at flush", async () => {
    const db = new FakeD1();
    const budget = new ApiBudget(db, () => 1000);
    const c = new CfClient({
      fetch: (async () => Response.json({ success: false, errors: [], result: null }, { status: 429, headers: { "retry-after": "42" } })) as typeof fetch,
      token: "t",
      baseUrl: "https://api.cloudflare.com/client/v4",
      budget,
      userAgent: "t",
      sleep: async () => {},
    });
    await expect(c.request("GET", "/x", { priority: "interactive" })).rejects.toMatchObject({ kind: "rate_limited", retryAfter: 42 });
    await expect(c.request("GET", "/x", { priority: "interactive" })).rejects.toMatchObject({ kind: "rate_limited", retryAfter: 42 });
    const before = db.queries;
    await budget.flush();
    await budget.flush();
    expect(db.queries - before).toBe(1);
    expect(db.sqlite.prepare("SELECT blocked_until, remaining FROM cf_api_budget").get()).toEqual({ blocked_until: 1042, remaining: 0 });
  });

  it("stores the Ratelimit observation", async () => {
    const s = setup();
    await s.c.request("GET", "/x", { priority: "interactive" });
    await s.budget.flush();
    expect(s.db.sqlite.prepare("SELECT remaining, reset_at FROM cf_api_budget").get()).toEqual({ remaining: 900, reset_at: 1100 });
  });
});
