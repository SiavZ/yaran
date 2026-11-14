/**
 * Shared pieces of the reconcile tasks: per-run limits, outcomes, task cursors and the
 * budget yield.
 *
 * Each reconcile task does one bounded slice per cron run and keeps its position in its own
 * `scheduled_tasks.cursor` (JSON). When the Cloudflare budget is below the background
 * reserve, or blocked by a 429, a task stops and reports why instead of failing.
 *
 * - Limits mirror 04's dispatcher caps (40 D1 queries, 40 subrequests per run); tasks stay
 *   under them on their own.
 *
 * <module-headers:begin>
 * Uses:
 * src/reconcile/kit.ts
 * ├── src/cloudflare/errors.ts
 * └── src/provisioning/ports.ts
 * External: none
 *
 * Used by:
 * src/reconcile/kit.ts
 * ├── src/provisioning/quota.ts
 * ├── src/reconcile/drift.ts
 * ├── src/reconcile/orphans.ts
 * ├── src/reconcile/status.ts
 * ├── src/reconcile/tasks.ts
 * ├── test/provisioning/drift.test.ts
 * └── test/provisioning/status.test.ts
 * <module-headers:end>
 */
import { CfApiError } from "../cloudflare/errors.ts";
import type { D1Stmt, ProvCtx } from "../provisioning/ports.ts";

export interface TaskLimits {
  subrequests: number;
  queries: number;
}

export const DEFAULT_TASK_LIMITS: TaskLimits = { subrequests: 40, queries: 40 };

export interface TaskOutcome {
  /** False when the run was skipped or cut short; `note` says why (the dispatcher records it). */
  ok: boolean;
  note: string;
}

export async function readTaskCursor<T extends object>(ctx: ProvCtx, task: string): Promise<Partial<T>> {
  const row = await ctx.db.prepare("SELECT cursor FROM scheduled_tasks WHERE task = ?").bind(task).first<{ cursor: string | null }>();
  try {
    return row?.cursor ? (JSON.parse(row.cursor) as Partial<T>) : {};
  } catch {
    return {};
  }
}

/** Two statements (create the row if absent, then set the cursor), for a caller's batch. */
export function writeTaskCursorStmts(ctx: ProvCtx, task: string, value: object): D1Stmt[] {
  const json = JSON.stringify(value);
  return [
    ctx.db.prepare("INSERT OR IGNORE INTO scheduled_tasks (task, next_run_at, cursor) VALUES (?, ?, ?)").bind(task, ctx.now(), json),
    ctx.db.prepare("UPDATE scheduled_tasks SET cursor = ? WHERE task = ?").bind(json, task),
  ];
}

/** Runs a task body; a budget refusal or 429 becomes a recorded skip instead of an error. */
export async function yieldingToBudget(task: string, ctx: ProvCtx, run: () => Promise<TaskOutcome>): Promise<TaskOutcome> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof CfApiError && err.kind === "rate_limited") {
      const note = `${task} yielded: ${ctx.sanitize(err.message)}`;
      ctx.log.info("reconcile.yield", { task, note });
      return { ok: false, note };
    }
    throw err;
  } finally {
    await ctx.cf.budget.flush();
  }
}
