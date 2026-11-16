/**
 * Task registry and run limits: budget yield under the reserve, per-run caps of 40 queries and
 * 40 subrequests, drive_ops liveness, requestReconcile (W28, hook H5).
 *
 * <module-headers:begin>
 * Uses:
 * test/provisioning/tasks.test.ts
 * ├── src/provisioning/index.ts
 * ├── src/provisioning/ports.ts
 * ├── src/reconcile/tasks.ts
 * ├── test/provisioning/fake-cloudflare/faults.ts
 * └── test/provisioning/helpers/world.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test in cloud/worker (workerd, or Node for test/provisioning))
 * <module-headers:end>
 */
import { describe, expect, it } from "vitest";
import { requestReconcile, startProvision } from "../../src/provisioning/index.ts";
import { countQueries } from "../../src/provisioning/ports.ts";
import { runDriveOps, RECONCILE_TASKS } from "../../src/reconcile/tasks.ts";
import { on } from "./fake-cloudflare/faults.ts";
import { machine, makeWorld, ops, seedMachine, setSetting, type World } from "./helpers/world.ts";

async function active(w: World): Promise<string> {
  const id = seedMachine(w);
  await startProvision(w.ctx, id);
  w.db.sqlite.prepare("UPDATE machines SET status = 'active' WHERE id = ?").run(id);
  return id;
}

describe("reconcile tasks", () => {
  it("registers the four tasks with their intervals", () => {
    expect(RECONCILE_TASKS.map((t) => [t.task, t.intervalSeconds])).toEqual([
      ["cf_status", 60],
      ["cf_drift", 300],
      ["cf_orphans", 3600],
      ["drive_ops", 60],
    ]);
  });

  it("every task skips and records why when the budget is under the background reserve", async () => {
    const w = makeWorld();
    await active(w);
    w.db.sqlite.prepare("INSERT OR REPLACE INTO cf_api_budget (id, remaining, reset_at, blocked_until, observed_at) VALUES (1, 500, ?, NULL, 0)").run(w.clock.now + 200);
    const id2 = seedMachine(w);
    w.db.sqlite
      .prepare("INSERT INTO provisioning_ops (id, machine_id, kind, state, step, params, next_attempt_at, requested_by, created_at, updated_at) VALUES ('op', ?, 'provision', 'pending', 'preflight', ?, 0, 'u', 0, 0)")
      .run(id2, JSON.stringify({ plan: ["preflight"], intent: {} }));
    w.cf.calls.length = 0;
    for (const t of RECONCILE_TASKS) {
      const r = await t.run(w.fresh(), { subrequests: 40, queries: 40 });
      if (t.task === "drive_ops") {
        // drive_ops itself does not fail: the op it drives yields and is rescheduled.
        expect(r.ok).toBe(true);
        expect(ops(w, id2)[0]).toMatchObject({ state: "pending", last_error_code: "cloudflare_rate_limited" });
      } else {
        expect(r.ok, t.task).toBe(false);
        expect(r.note).toMatch(/yielded: .*500 Cloudflare API calls left, background work needs more than 600/);
      }
    }
    expect(w.cf.calls).toHaveLength(0);
  });

  it("stays within its declared cost (at most 40 D1 queries and 40 subrequests) per run", async () => {
    for (const t of RECONCILE_TASKS) expect(t.cost.queries <= 40 && t.cost.subrequests <= 40, t.task).toBe(true);
    const w = makeWorld();
    setSetting(w, "drift_machines_per_run", 8);
    for (let i = 0; i < 9; i++) await active(w);
    // Due work for drive_ops: three fresh provisions.
    for (let i = 0; i < 3; i++) {
      const id = seedMachine(w);
      w.cf.faults.push({ kind: "transient", when: on("POST", /access\/policies$/) });
      await startProvision(w.ctx, id);
    }
    w.clock.now += 3600;
    for (const t of RECONCILE_TASKS) {
      for (let run = 0; run < 4; run++) {
        const counted = countQueries(w.fresh());
        const before = w.cf.calls.length;
        await t.run(counted.ctx, t.cost);
        expect(counted.queries(), `${t.task} queries`).toBeLessThanOrEqual(t.cost.queries);
        expect(w.cf.calls.length - before, `${t.task} subrequests`).toBeLessThanOrEqual(t.cost.subrequests);
      }
    }
  });

  it("steady state stays far under 30 calls per 5 minutes", async () => {
    const w = makeWorld();
    for (let i = 0; i < 6; i++) await active(w);
    w.cf.calls.length = 0;
    const byTask = Object.fromEntries(RECONCILE_TASKS.map((t) => [t.task, t]));
    for (let minute = 0; minute < 5; minute++) {
      await byTask["cf_status"]!.run(w.fresh(), { subrequests: 40, queries: 40 });
      await byTask["drive_ops"]!.run(w.fresh(), { subrequests: 40, queries: 40 });
    }
    await byTask["cf_drift"]!.run(w.fresh(), { subrequests: 40, queries: 40 });
    // cf_orphans runs hourly: one run's share of a 5-minute window rounds to ≤ 1 call.
    expect(w.cf.calls.length).toBeLessThanOrEqual(25);
  });

  it("drive_ops starts the teardown a stranded revoking machine never got", async () => {
    const w = makeWorld();
    const id = await active(w);
    w.db.sqlite.prepare("UPDATE machines SET status = 'revoking', revoke_reason = 'stale' WHERE id = ?").run(id);
    await runDriveOps(w.fresh());
    await runDriveOps(w.fresh());
    expect(machine(w, id)["status"]).toBe("revoked");
  });

  it("requestReconcile schedules the three tasks now, resets the drift cursor and audits, with no API call", async () => {
    const w = makeWorld();
    w.db.sqlite.prepare("INSERT INTO scheduled_tasks (task, next_run_at, cursor) VALUES ('cf_drift', 99999999999, ?)").run(JSON.stringify({ after: "x", priority: ["p"] }));
    w.cf.calls.length = 0;
    await requestReconcile(w.ctx);
    const rows = w.db.sqlite.prepare("SELECT task, next_run_at, cursor FROM scheduled_tasks ORDER BY task").all() as Array<{ task: string; next_run_at: number; cursor: string | null }>;
    expect(rows.map((r) => [r.task, r.next_run_at])).toEqual([
      ["cf_drift", w.clock.now],
      ["cf_orphans", w.clock.now],
      ["cf_status", w.clock.now],
    ]);
    expect(JSON.parse(rows[0]!.cursor!)).toEqual({ after: null, priority: ["p"] });
    expect(w.audits.at(-1)).toMatchObject({ action: "machine.reconciled", target: { kind: "org", id: null } });
    expect(w.cf.calls).toHaveLength(0);
  });
});
