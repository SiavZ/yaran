/**
 * Ops store and engine mechanics: one live op, lease exclusivity and expiry, backoff,
 * max attempts, audit per transition.
 *
 * <module-headers:begin>
 * Uses:
 * test/provisioning/ops-store.test.ts
 * ├── src/provisioning/engine.ts
 * ├── src/provisioning/ops-store.ts
 * ├── test/provisioning/fake-cloudflare/faults.ts
 * └── test/provisioning/helpers/world.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test in cloud/worker (workerd, or Node for test/provisioning))
 * <module-headers:end>
 */
import { describe, expect, it } from "vitest";
import { driveOp, INLINE_BUDGET, PROVISION_PLAN } from "../../src/provisioning/engine.ts";
import { acquireLease, backoffSeconds, LEASE_SECONDS, loadOp, startOp } from "../../src/provisioning/ops-store.ts";
import { on } from "./fake-cloudflare/faults.ts";
import { makeWorld, ops, seedMachine, setSetting } from "./helpers/world.ts";

const newOp = (machineId: string, now: number) => ({ machineId, kind: "provision" as const, params: { plan: PROVISION_PLAN, intent: {} }, requestedBy: "u", now });

describe("ops store", () => {
  it("allows one live op per machine; a second start returns the first", async () => {
    const w = makeWorld();
    const id = seedMachine(w);
    const a = await startOp(w.db, newOp(id, 1));
    const b = await startOp(w.db, { ...newOp(id, 2), kind: "repair" });
    expect(a.created).toBe(true);
    expect(b).toMatchObject({ created: false, op: { id: a.op.id, kind: "provision" } });
    expect(ops(w, id)).toHaveLength(1);
  });

  it("lets exactly one of two concurrent drivers hold the lease, and another resume after expiry", async () => {
    const w = makeWorld();
    const id = seedMachine(w);
    const { op } = await startOp(w.db, newOp(id, 100));
    const results = await Promise.all([acquireLease(w.db, op.id, "d1", 100), acquireLease(w.db, op.id, "d2", 100)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await acquireLease(w.db, op.id, "d3", 100 + LEASE_SECONDS - 1)).toBe(false);
    expect(await acquireLease(w.db, op.id, "d3", 100 + LEASE_SECONDS + 1)).toBe(true);
    expect((await loadOp(w.db, op.id))?.lease_owner).toBe("d3");
  });

  it("a driver that finds the lease taken does nothing", async () => {
    const w = makeWorld();
    const id = seedMachine(w);
    const { op } = await startOp(w.db, newOp(id, w.clock.now));
    await acquireLease(w.db, op.id, "other", w.clock.now);
    const r = await driveOp(w.ctx, op.id, INLINE_BUDGET);
    expect(r.op.step).toBe("preflight");
    expect(w.cf.calls).toHaveLength(0);
  });

  it("backs off 30 s, 2 min, 10 min, 30 min, then hourly", () => {
    expect([1, 2, 3, 4, 5, 9].map(backoffSeconds)).toEqual([30, 120, 600, 1800, 3600, 3600]);
  });
});

describe("engine error policy", () => {
  it("defers transient failures with backoff and fails after provision_max_attempts (compensating a provision)", async () => {
    const w = makeWorld();
    setSetting(w, "provision_max_attempts", 3);
    const id = seedMachine(w);
    w.cf.faults.push({ kind: "transient", when: on("POST", /access\/policies$/), times: 99 });
    const { op } = await startOp(w.db, newOp(id, w.clock.now));
    let r = await driveOp(w.ctx, op.id, INLINE_BUDGET);
    expect(r.op).toMatchObject({ state: "pending", attempt: 1, last_error_code: "cloudflare_unavailable" });
    expect(r.op.next_attempt_at).toBe(w.clock.now + 30);
    w.clock.now += 30;
    r = await driveOp(w.ctx, op.id, INLINE_BUDGET);
    expect(r.op).toMatchObject({ attempt: 2 });
    expect(r.op.next_attempt_at).toBe(w.clock.now + 120);
    w.clock.now += 120;
    r = await driveOp(w.ctx, op.id, INLINE_BUDGET);
    expect(r.op.state).toBe("compensated");
    expect(r.op.last_error_code).toBe("cloudflare_unavailable");
    const actions = w.audits.map((a) => `${a.action}:${a.outcome}`);
    expect(actions).toContain("provision.step:ok");
    expect(actions.filter((a) => a === "provision.step:failed")).toHaveLength(2);
    expect(actions).toContain("provision.failed:failed");
    expect(actions.at(-1)).toBe("teardown.done:ok");
  });

  it("defers a 429 until at least its retry-after and audits cloudflare.rate_limited", async () => {
    const w = makeWorld();
    const id = seedMachine(w);
    w.cf.faults.push({ kind: "rate_limit", when: on("POST", /access\/apps$/) });
    const { op } = await startOp(w.db, newOp(id, w.clock.now));
    const r = await driveOp(w.ctx, op.id, INLINE_BUDGET);
    expect(r.op).toMatchObject({ state: "pending", step: "app", last_error_code: "cloudflare_rate_limited" });
    expect(r.op.next_attempt_at).toBeGreaterThanOrEqual(w.clock.now + 30);
    expect(w.audits.some((a) => a.action === "cloudflare.rate_limited")).toBe(true);
  });

  it("stops when the drive budget is spent and resumes later", async () => {
    const w = makeWorld();
    const id = seedMachine(w);
    const { op } = await startOp(w.db, newOp(id, w.clock.now));
    const r = await driveOp(w.ctx, op.id, { wallMs: 10_000, apiCalls: 3 });
    expect(r.op.state).toBe("pending");
    expect(r.op.lease_owner).toBeNull();
    const r2 = await driveOp(w.ctx, op.id, INLINE_BUDGET);
    expect(r2.op.state).toBe("succeeded");
  });
});
