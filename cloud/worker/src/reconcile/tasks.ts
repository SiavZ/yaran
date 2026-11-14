/**
 * Registration rows for 04's cron task registry, and the `drive_ops` task.
 *
 * Phase 04's dispatcher (`scheduled/tasks.ts`) appends `RECONCILE_TASKS`; each row names the
 * task, its interval and the function the dispatcher calls with a context and its per-run
 * limits. `drive_ops` gives the saga liveness without Queues or Durable Objects: it drives up
 * to three due ops per run and starts the teardown of a machine left `revoking` with none.
 *
 * - Every task runs at `background` priority and stays inside the per-run caps.
 *
 * <module-headers:begin>
 * Uses:
 * src/reconcile/tasks.ts
 * ├── src/provisioning/engine.ts
 * ├── src/provisioning/ops-store.ts
 * ├── src/provisioning/ports.ts
 * ├── src/reconcile/drift.ts
 * ├── src/reconcile/kit.ts
 * ├── src/reconcile/orphans.ts
 * └── src/reconcile/status.ts
 * External: none
 *
 * Used by:
 * src/reconcile/tasks.ts
 * ├── test/provisioning/crash-matrix.test.ts
 * ├── test/provisioning/drift.test.ts
 * ├── test/provisioning/origin-port.test.ts
 * └── test/provisioning/tasks.test.ts
 * <module-headers:end>
 */
import { driveOp, TEARDOWN_PLAN } from "../provisioning/engine.ts";
import { dueOps, startOp } from "../provisioning/ops-store.ts";
import { countQueries, type ProvCtx } from "../provisioning/ports.ts";
import { runCfDrift } from "./drift.ts";
import { DEFAULT_TASK_LIMITS, yieldingToBudget, type TaskLimits, type TaskOutcome } from "./kit.ts";
import { runCfOrphans } from "./orphans.ts";
import { runCfStatus } from "./status.ts";

export const DRIVE_OPS_TASK = "drive_ops";
export const DRIVE_OPS_PER_RUN = 3;

export interface ReconcileTaskRow {
  task: string;
  intervalSeconds: number;
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

/** Appended to 04's `scheduled/tasks.ts` registry. */
export const RECONCILE_TASKS: readonly ReconcileTaskRow[] = [
  { task: "cf_status", intervalSeconds: 60, run: (ctx) => runCfStatus(ctx) },
  { task: "cf_drift", intervalSeconds: 300, run: runCfDrift },
  { task: "cf_orphans", intervalSeconds: 3600, run: runCfOrphans },
  { task: DRIVE_OPS_TASK, intervalSeconds: 60, run: runDriveOps },
];
