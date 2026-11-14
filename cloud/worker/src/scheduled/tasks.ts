/**
 * The typed cron task registry. The Worker declares ONE cron expression (`* * * * *`,
 * because the Free plan allows five per account), and the dispatcher picks due tasks from
 * this list every minute.
 *
 * How a phase adds tasks: export a `readonly TaskDef[]` from a module of its own (for
 * example `src/reconcile/tasks.ts`), then add ONE import and ONE spread line to `TASKS`.
 * A task must do a bounded slice of work per run (the Free plan allows 10 ms of CPU) and
 * declare the most D1 queries and external subrequests one run can spend; the dispatcher
 * starts it only when its declared cost still fits the run's budget.
 *
 * <module-headers:begin>
 * Uses:
 * src/scheduled/tasks.ts
 * ├── src/admin/scheduled-jobs.ts
 * ├── src/http/context.ts
 * ├── src/pairing/sweep.ts
 * ├── src/push/routes.ts
 * ├── src/reconcile/tasks.ts
 * └── src/scheduled/purge.ts
 * External: none
 *
 * Used by:
 * src/scheduled/tasks.ts
 * ├── src/admin/scheduled-jobs.ts
 * ├── src/index.ts
 * ├── src/pairing/sweep.ts
 * ├── src/push/routes.ts
 * ├── src/reconcile/tasks.ts
 * ├── src/scheduled/dispatcher.ts
 * ├── src/scheduled/purge.ts
 * ├── test/dispatcher.test.ts
 * └── test/purge.test.ts
 * <module-headers:end>
 */
import type { AppContext } from "../http/context.ts";
import { PHASE07_TASKS } from "../admin/scheduled-jobs.ts";
import { PAIR_SWEEP_TASKS } from "../pairing/sweep.ts";
import { PUSH_TASKS } from "../push/routes.ts";
import { RECONCILE_TASK_DEFS } from "../reconcile/tasks.ts";
import { PURGE_TASKS } from "./purge.ts";

export interface TaskContext extends AppContext {
  /** The task's saved cursor from its previous run, if any. */
  cursor: string | null;
  /** Wall-clock deadline for this run, in epoch milliseconds. */
  deadlineMs: number;
}

export interface TaskResult {
  /** Saved for the next run (null clears it). */
  cursor?: string | null;
  /** More work is waiting: run again on the next tick instead of after the interval. */
  more?: boolean;
}

export interface TaskDef {
  name: string;
  intervalS: number;
  /** Lower runs first; interactive-adjacent work (05's op driver) below background. */
  priority: number;
  /** The most one run can spend. */
  cost: { queries: number; subrequests: number };
  run(ctx: TaskContext): Promise<TaskResult | void>;
}

/** Every registered task. Phases 05 and 08 append one spread line each. */
export const TASKS: readonly TaskDef[] = [...PURGE_TASKS, ...RECONCILE_TASK_DEFS, ...PAIR_SWEEP_TASKS, ...PHASE07_TASKS, ...PUSH_TASKS];
