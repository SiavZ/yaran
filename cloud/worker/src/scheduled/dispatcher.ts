/**
 * The one cron dispatcher: every minute, run the due tasks from `tasks.ts` in priority
 * order, each under a D1 lease, inside a per-run budget.
 *
 * Budget per run: 20 s of wall time, 40 D1 queries and 40 external subrequests, which keeps
 * the Free plan's 50-query and 50-subrequest caps safe. The dispatcher's own bookkeeping
 * counts against it (registration and selection once per run, then a lease and a finish
 * per task). A task whose declared cost no longer fits is left due for the next run.
 *
 * - The lease (`lease_until`) stops overlapping invocations from running a task twice.
 * - A throwing task records a sanitized `last_error` and does not block the others.
 *
 * <module-headers:begin>
 * Uses:
 * src/scheduled/dispatcher.ts
 * ├── src/db/client.ts
 * ├── src/env.ts
 * ├── src/log/logger.ts
 * ├── src/scheduled/tasks.ts
 * └── src/security/sanitize.ts
 * External: none
 *
 * Used by:
 * src/scheduled/dispatcher.ts
 * ├── src/index.ts
 * └── test/dispatcher.test.ts
 * <module-headers:end>
 */
import { all, batch, run, stmt } from "../db/client.ts";
import type { Env } from "../env.ts";
import { createLogger } from "../log/logger.ts";
import { truncate } from "../security/sanitize.ts";
import type { TaskContext, TaskDef } from "./tasks.ts";

export const RUN_BUDGET = { wallMs: 20_000, queries: 40, subrequests: 40 } as const;
/** A lease outlives the run's wall budget, so a crashed run frees its tasks soon after. */
export const LEASE_S = 120;
const OVERHEAD_PER_TASK = 2;

interface TaskRow {
  task: string;
  next_run_at: number;
  cursor: string | null;
}

export interface DispatchReport {
  ran: string[];
  failed: string[];
  deferred: string[];
}

const starved = (t: { row: TaskRow; def: TaskDef }, now: number) => (now - t.row.next_run_at >= t.def.intervalS ? 0 : 1);

/** Runs one dispatcher pass at `nowMs` (the scheduled time). */
export async function dispatch(env: Env, tasks: readonly TaskDef[], nowMs: number): Promise<DispatchReport> {
  const now = Math.floor(nowMs / 1000);
  const started = Date.now();
  const deadlineMs = started + RUN_BUDGET.wallMs;
  const log = createLogger({ request_id: `cron-${now}` });
  const report: DispatchReport = { ran: [], failed: [], deferred: [] };
  const byName = new Map(tasks.map((t) => [t.name, t]));
  let queries = RUN_BUDGET.queries - 2;
  let subrequests = RUN_BUDGET.subrequests;

  await batch(env.DB, tasks.map((t) => stmt(env.DB, "INSERT OR IGNORE INTO scheduled_tasks (task, next_run_at) VALUES (?, ?)", t.name, now)));
  const due = (await all<TaskRow>(env.DB,
    "SELECT task, next_run_at, cursor FROM scheduled_tasks WHERE next_run_at <= ? AND (lease_until IS NULL OR lease_until < ?)", now, now))
    .flatMap((row) => {
      const def = byName.get(row.task);
      return def ? [{ row, def }] : [];
    })
    // A task overdue by a whole interval was deferred: it goes first, so the every-minute
    // tasks cannot starve a heavier one by always fitting ahead of it.
    .sort((a, b) => starved(a, now) - starved(b, now) || a.def.priority - b.def.priority || a.row.next_run_at - b.row.next_run_at);

  for (const { row, def } of due) {
    const need = def.cost.queries + OVERHEAD_PER_TASK;
    if (need > queries || def.cost.subrequests > subrequests || Date.now() >= deadlineMs) {
      report.deferred.push(def.name);
      continue;
    }
    queries -= need;
    subrequests -= def.cost.subrequests;
    const leased = await run(env.DB,
      "UPDATE scheduled_tasks SET lease_until = ? WHERE task = ? AND next_run_at <= ? AND (lease_until IS NULL OR lease_until < ?)",
      now + LEASE_S, def.name, now, now);
    if (leased !== 1) continue;
    const ctx: TaskContext = {
      env, db: env.DB, log: log.with({ task: def.name }), now: () => now, requestId: `cron-${now}`,
      ip: null, country: null, actor: () => ({ kind: "system" }), waitUntil: () => {},
      cursor: row.cursor, deadlineMs,
    };
    try {
      const result = (await def.run(ctx)) ?? {};
      // An absent cursor leaves the column alone: some tasks (05) keep their own cursor there.
      const keep = result.cursor === undefined ? 1 : 0;
      await run(env.DB,
        "UPDATE scheduled_tasks SET next_run_at = ?, cursor = CASE WHEN ? THEN cursor ELSE ? END, lease_until = NULL, last_ok_at = ?, last_error = NULL WHERE task = ?",
        result.more ? now : now + def.intervalS, keep, result.cursor ?? null, now, def.name);
      report.ran.push(def.name);
    } catch (err) {
      const text = truncate(err instanceof Error ? err.message : String(err), 1024);
      ctx.log.error("task_failed", { error: text });
      await run(env.DB,
        "UPDATE scheduled_tasks SET next_run_at = ?, lease_until = NULL, last_error = ? WHERE task = ?",
        now + def.intervalS, text, def.name);
      report.failed.push(def.name);
    }
  }
  if (report.deferred.length) log.warn("tasks_deferred", { tasks: report.deferred });
  return report;
}
