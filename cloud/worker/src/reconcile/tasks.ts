/**
 * Registration rows for 04's cron task registry, and the `drive_ops` task.
 *
 * Phase 04's dispatcher (`scheduled/tasks.ts`) appends `RECONCILE_TASKS`; each row names the
 * task, its interval and the function the dispatcher calls with a context and its per-run
 * limits. `drive_ops` gives the saga liveness without Queues or Durable Objects: it drives up
 * to three due ops per run and starts the teardown of a machine left `revoking` with none.
 *
 * - Every task runs at `background` priority and stays inside the per-run caps.
 * - `cost` is the most one run may spend; `drive_ops` honours it, and the tasks test pins
 *   the others' measured worst case under it.
 * - `RECONCILE_TASK_DEFS` is the same list as 04 `TaskDef`s, spread into `TASKS`.
 *
 * <module-headers:begin>
 * Uses:
 * src/reconcile/tasks.ts
 * ├── src/provisioning/context.ts
 * ├── src/provisioning/engine.ts
 * ├── src/provisioning/ops-store.ts
 * ├── src/provisioning/ports.ts
 * ├── src/provisioning/provision-error.ts
 * ├── src/reconcile/drift.ts
 * ├── src/reconcile/kit.ts
 * ├── src/reconcile/orphans.ts
 * ├── src/reconcile/status.ts
 * └── src/scheduled/tasks.ts
 * External: none
 *
 * Used by:
 * src/reconcile/tasks.ts
 * ├── src/scheduled/tasks.ts
 * ├── test/provisioning/crash-matrix.test.ts
 * ├── test/provisioning/drift.test.ts
 * ├── test/provisioning/origin-port.test.ts
 * └── test/provisioning/tasks.test.ts
 * <module-headers:end>
 */
import { provCtx } from "../provisioning/context.ts";
import { driveOp, TEARDOWN_PLAN } from "../provisioning/engine.ts";
import { dueOps, startOp } from "../provisioning/ops-store.ts";
import { countQueries, type ProvCtx } from "../provisioning/ports.ts";
import { ProvisionError } from "../provisioning/provision-error.ts";
import type { TaskDef } from "../scheduled/tasks.ts";
import { runCfDrift } from "./drift.ts";
import { DEFAULT_TASK_LIMITS, yieldingToBudget, type TaskLimits, type TaskOutcome } from "./kit.ts";
import { runCfOrphans } from "./orphans.ts";
import { runCfStatus } from "./status.ts";

export const DRIVE_OPS_TASK = "drive_ops";
export const DRIVE_OPS_PER_RUN = 3;

export interface ReconcileTaskRow {
  task: string;
  intervalSeconds: number;
  /** 04 dispatcher order: lower first; `drive_ops` is interactive-adjacent. */
  priority: number;
  cost: TaskLimits;
  run: (ctx: ProvCtx, limits: TaskLimits) => Promise<TaskOutcome>;
}

export function runDriveOps(base: ProvCtx, limits: TaskLimits = DEFAULT_TASK_LIMITS): Promise<TaskOutcome> {
  const counted = countQueries(base);
  const ctx = counted.ctx;
  return yieldingToBudget(DRIVE_OPS_TASK, ctx, async () => {
    const now = ctx.now();
    // A teardown whose op was never inserted (superseded op lost to a crash) starts here.
    const { results: stranded } = await ctx.db
      .prepare(
        `SELECT m.id FROM machines m WHERE m.status = 'revoking'
           AND NOT EXISTS (SELECT 1 FROM provisioning_ops o WHERE o.machine_id = m.id AND (o.kind = 'teardown' OR o.state IN ('pending','running','compensating')))
         LIMIT ?`,
      )
      .bind(DRIVE_OPS_PER_RUN)
      .all<{ id: string }>();
    for (const m of stranded) {
      await startOp(ctx.db, { machineId: m.id, kind: "teardown", params: { plan: TEARDOWN_PLAN, intent: {} }, requestedBy: "system", now });
    }
    const ids = await dueOps(ctx.db, now, DRIVE_OPS_PER_RUN);
    const startCalls = ctx.cf.calls;
    let driven = 0;
    for (const id of ids) {
      const calls = limits.subrequests - (ctx.cf.calls - startCalls);
      const queries = limits.queries - counted.queries();
      if (calls <= 0 || queries <= 8) break;
      await driveOp(ctx, id, { wallMs: 20_000, apiCalls: Math.min(calls, 20), queries }, "background");
      driven++;
    }
    return { ok: true, note: `drove ${driven} of ${ids.length} due provisioning ops; started ${stranded.length} stranded teardowns` };
  });
}

export const RECONCILE_TASKS: readonly ReconcileTaskRow[] = [
  { task: "cf_status", intervalSeconds: 60, priority: 30, cost: { queries: 6, subrequests: 1 }, run: (ctx) => runCfStatus(ctx) },
  // 32 calls = 4 per machine at the `drift_machines_per_run` maximum of 8.
  { task: "cf_drift", intervalSeconds: 300, priority: 40, cost: { queries: 16, subrequests: 32 }, run: runCfDrift },
  { task: "cf_orphans", intervalSeconds: 3600, priority: 45, cost: { queries: 16, subrequests: 9 }, run: runCfOrphans },
  { task: DRIVE_OPS_TASK, intervalSeconds: 60, priority: 20, cost: { queries: 24, subrequests: 20 }, run: runDriveOps },
];

/**
 * The rows as 04 dispatcher tasks. Before setup has stored the Cloudflare identifiers, or
 * without an API token, a run is a logged skip rather than a recorded failure every minute.
 */
export const RECONCILE_TASK_DEFS: readonly TaskDef[] = RECONCILE_TASKS.map((row) => ({
  name: row.task,
  intervalS: row.intervalSeconds,
  priority: row.priority,
  cost: { queries: row.cost.queries, subrequests: row.cost.subrequests },
  run: async (ctx) => {
    if (!ctx.env.CF_API_TOKEN) {
      ctx.log.warn("task_skipped", { reason: "CF_API_TOKEN is not set" });
      return;
    }
    try {
      const outcome = await row.run(provCtx(ctx), row.cost);
      if (!outcome.ok) ctx.log.info("task_yielded", { note: outcome.note });
    } catch (err) {
      if (err instanceof ProvisionError && err.code === "setup_incomplete") {
        ctx.log.info("task_skipped", { reason: err.message });
        return;
      }
      throw err;
    }
  },
}));
