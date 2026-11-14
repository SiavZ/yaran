/**
 * The cron dispatcher: selection and priority, leases across overlapping runs, budgets,
 * failure isolation, and the production entry through `createScheduledController`.
 *
 * <module-headers:begin>
 * Uses:
 * test/dispatcher.test.ts
 * ├── src/db/client.ts
 * ├── src/index.ts
 * ├── src/scheduled/dispatcher.ts
 * └── src/scheduled/tasks.ts
 * External: cloudflare:test, vitest
 *
 * Used by: entry point (vitest, via npm test in cloud/worker (workerd, or Node for test/provisioning))
 * <module-headers:end>
 */
import { createScheduledController, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all, one } from "../src/db/client.ts";
import worker from "../src/index.ts";
import { dispatch, RUN_BUDGET } from "../src/scheduled/dispatcher.ts";
import { TASKS, type TaskDef } from "../src/scheduled/tasks.ts";

const T0 = 1_800_000_000_000;
let n = 0;
const task = (o: Partial<TaskDef> & { log?: string[] }): TaskDef => {
  const name = o.name ?? `t${++n}`;
  return { name, intervalS: 60, priority: 10, cost: { queries: 1, subrequests: 0 }, run: async () => { o.log?.push(name); }, ...o };
};
const row = (name: string) => one<{ next_run_at: number; lease_until: number | null; last_error: string | null; last_ok_at: number | null; cursor: string | null }>(
  env.DB, "SELECT next_run_at, lease_until, last_error, last_ok_at, cursor FROM scheduled_tasks WHERE task = ?", name);

describe("dispatch", () => {
  it("runs due tasks in priority order and schedules the next run", async () => {
    const log: string[] = [];
    const tasks = [task({ priority: 30, log }), task({ priority: 10, log }), task({ priority: 20, log, intervalS: 600 })];
    await dispatch(env, tasks, T0);
    expect(log).toEqual([tasks[1]!.name, tasks[2]!.name, tasks[0]!.name]);
    expect(await row(tasks[2]!.name)).toMatchObject({ next_run_at: T0 / 1000 + 600, lease_until: null, last_ok_at: T0 / 1000 });
    log.length = 0;
    await dispatch(env, tasks, T0 + 30_000);
    expect(log).toEqual([]);
    await dispatch(env, tasks, T0 + 61_000);
    expect(log).toEqual([tasks[1]!.name, tasks[0]!.name]);
  });

  it("keeps the cursor and reruns on the next tick when a task has more work", async () => {
    const t = task({ run: async (ctx) => ({ cursor: `${ctx.cursor ?? ""}x`, more: true }) });
    await dispatch(env, [t], T0);
    expect(await row(t.name)).toMatchObject({ cursor: "x", next_run_at: T0 / 1000 });
    await dispatch(env, [t], T0 + 60_000);
    expect((await row(t.name))!.cursor).toBe("xx");
  });

  it("never runs a task twice across overlapping invocations", async () => {
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = task({ run: async () => { runs++; await gate; } });
    const first = dispatch(env, [slow], T0);
    await new Promise((r) => setTimeout(r, 50));
    const second = await dispatch(env, [slow], T0);
    release();
    await first;
    expect(runs).toBe(1);
    expect(second.ran).toEqual([]);
  });

  it("defers what no longer fits the budget to the next run", async () => {
    const log: string[] = [];
    const big = task({ log, priority: 1, cost: { queries: RUN_BUDGET.queries - 10, subrequests: 0 } });
    const tooMuch = task({ log, priority: 2, cost: { queries: 20, subrequests: 0 } });
    const net = task({ log, priority: 3, cost: { queries: 1, subrequests: RUN_BUDGET.subrequests + 1 } });
    const small = task({ log, priority: 4 });
    const report = await dispatch(env, [big, tooMuch, net, small], T0);
    expect(log).toEqual([big.name, small.name]);
    expect(report.deferred).toEqual([tooMuch.name, net.name]);
    expect((await row(tooMuch.name))!.next_run_at).toBe(T0 / 1000);
  });

  it("leaves a cursor the task wrote itself alone when the result names none", async () => {
    const t = task({});
    t.run = async (ctx) => { await ctx.db.prepare("UPDATE scheduled_tasks SET cursor = 'own' WHERE task = ?").bind(t.name).run(); };
    await dispatch(env, [t], T0);
    expect((await row(t.name))!.cursor).toBe("own");
  });

  it("runs a task deferred for a whole interval ahead of higher-priority ones", async () => {
    const log: string[] = [];
    const busy = task({ log, priority: 1, cost: { queries: RUN_BUDGET.queries - 10, subrequests: 0 } });
    const heavy = task({ log, priority: 2, intervalS: 300, cost: { queries: 20, subrequests: 0 } });
    for (let minute = 0; minute < 5; minute++) await dispatch(env, [busy, heavy], T0 + minute * 60_000);
    expect(log).toEqual([busy.name, busy.name, busy.name, busy.name, busy.name]);
    log.length = 0;
    await dispatch(env, [busy, heavy], T0 + 300_000);
    expect(log).toEqual([heavy.name]);
  });

  it("records a sanitized last_error and keeps running the others", async () => {
    const log: string[] = [];
    const bad = task({ priority: 1, run: async () => { throw new Error("kaboom \u001b[2J"); } });
    const good = task({ priority: 2, log });
    const report = await dispatch(env, [bad, good], T0);
    expect(report).toMatchObject({ failed: [bad.name], ran: [good.name] });
    expect(await row(bad.name)).toMatchObject({ last_error: "kaboom \\x1b[2J", lease_until: null, next_run_at: T0 / 1000 + 60 });
  });
});

describe("production entry", () => {
  it("declares exactly one cron and registers 04's tasks through the scheduled handler", async () => {
    const controller = createScheduledController({ scheduledTime: new Date(T0), cron: "* * * * *" });
    await worker.scheduled(controller, env);
    const names = (await all<{ task: string }>(env.DB, "SELECT task FROM scheduled_tasks")).map((r) => r.task);
    for (const t of TASKS) expect(names).toContain(t.name);
    expect(TASKS.map((t) => t.name)).toEqual(expect.arrayContaining(["purge_nonces", "purge_pair_requests", "purge_audit", "purge_rate_counters", "reseal_data",
      "cf_status", "cf_drift", "cf_orphans", "drive_ops"]));
    expect(new Set(TASKS.map((t) => t.name)).size).toBe(TASKS.length);
  });
});
