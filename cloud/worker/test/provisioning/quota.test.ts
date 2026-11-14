/**
 * Quota guard: refusal arithmetic, the 90% warning, and observation freshness.
 *
 * <module-headers:begin>
 * Uses:
 * test/provisioning/quota.test.ts
 * ├── src/provisioning/quota.ts
 * ├── src/provisioning/settings.ts
 * └── test/provisioning/helpers/world.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test in cloud/worker (workerd, or Node for test/provisioning))
 * <module-headers:end>
 */
import { describe, expect, it } from "vitest";
import { ensureQuota, quotaRefusal, quotaWarnings, readOrphansCursor } from "../../src/provisioning/quota.ts";
import { loadProvSettings } from "../../src/provisioning/settings.ts";
import { makeWorld } from "./helpers/world.ts";

const LIMITS = { access_apps: 500, access_policies: 500, tunnels: 1000 };
const obs = (apps: number, policies: number, tunnels: number) => ({ apps_total: apps, policies_total: policies, tunnels_total: tunnels, observed_at: 0 });

describe("quota", () => {
  it("refuses when one more would exceed a limit", () => {
    expect(quotaRefusal(obs(499, 0, 0), LIMITS)).toBeNull();
    expect(quotaRefusal(obs(500, 0, 0), LIMITS)).toEqual({ resource: "access_apps", used: 500, limit: 500 });
    expect(quotaRefusal(obs(0, 0, 1000), LIMITS)).toEqual({ resource: "tunnels", used: 1000, limit: 1000 });
  });

  it("warns at 90%", () => {
    expect(quotaWarnings(obs(449, 450, 899), LIMITS).map((u) => u.resource)).toEqual(["access_policies"]);
    expect(quotaWarnings(obs(450, 0, 900), LIMITS).map((u) => u.resource)).toEqual(["access_apps", "tunnels"]);
  });

  it("uses a fresh observation and refreshes a stale one with three per_page=1 calls", async () => {
    const w = makeWorld();
    const s = await loadProvSettings(w.ctx);
    await ensureQuota(w.ctx, s, "m", "interactive");
    expect(w.cf.calls.map((c) => c.query)).toEqual(["?page=1&per_page=1", "?page=1&per_page=1", "?is_deleted=false&page=1&per_page=1"]);
    await ensureQuota(w.ctx, s, "m", "interactive");
    expect(w.cf.calls).toHaveLength(3);
    w.clock.now += 3600;
    await ensureQuota(w.ctx, s, "m", "interactive");
    expect(w.cf.calls).toHaveLength(6);
    expect((await readOrphansCursor(w.ctx)).quota).toMatchObject({ apps_total: 0, observed_at: w.clock.now });
  });
});
