/**
 * The pairing sweep: expires pair requests past their 10 minutes, moves the
 * `awaiting_claim` (or still provisioning) machines they left behind to `revoking`, and
 * purges expired handoff csrf rows. 05's `drive_ops` task then runs the ordered teardown
 * (D21) a revoking machine needs, so this task makes no Cloudflare call.
 *
 * - Registered as one task on 04's existing one-minute cron dispatcher (no new cron slot);
 *   each run handles a bounded slice so it fits the Free plan's per-run budgets.
 * - Every expiry is audited as `pair.expired` with the system as actor.
 *
 * <module-headers:begin>
 * Uses:
 * src/pairing/sweep.ts
 * ├── src/machines/machine-rows.ts
 * ├── src/pairing/pair-requests.ts
 * ├── src/provisioning/machine-rows.ts
 * ├── src/routes/call.ts
 * ├── src/routes/phase06-context.ts
 * └── src/scheduled/tasks.ts
 * External: none
 *
 * Used by:
 * src/pairing/sweep.ts
 * ├── src/scheduled/tasks.ts
 * ├── test/pairing/audit-coverage.test.ts
 * └── test/pairing/pair-requests.test.ts
 * <module-headers:end>
 */
import { getMachine } from "../machines/machine-rows.ts";
import { markRevokingStmt } from "../provisioning/machine-rows.ts";
import type { FoundationCtx } from "../routes/call.ts";
import { foundationCtx } from "../routes/phase06-context.ts";
import type { TaskDef } from "../scheduled/tasks.ts";
import { dueForExpiry, expire } from "./pair-requests.ts";

export const SWEEP_SLICE = 4;

export interface SweepResult {
  expired: number;
  tornDown: number;
  csrfPurged: number;
}

export async function runPairSweep(ctx: FoundationCtx, slice = SWEEP_SLICE): Promise<SweepResult> {
  const result: SweepResult = { expired: 0, tornDown: 0, csrfPurged: 0 };
  for (const row of await dueForExpiry(ctx, slice)) {
    if (!(await expire(ctx, row.id))) continue;
    result.expired++;
    await ctx.audit.record({
      action: "pair.expired",
      actor: { kind: "system", id: null },
      target: row.machine_id ? { kind: "machine", id: row.machine_id } : { kind: "user", id: row.user_id },
      outcome: "ok",
      detail: { previous_status: row.status },
    });
    const machine = row.machine_id ? await getMachine(ctx, row.machine_id) : null;
    if (machine && (machine.status === "awaiting_claim" || machine.status === "provisioning")) {
      if ((await markRevokingStmt(ctx.db, machine.id, "stale", "system").run()).meta.changes === 1) result.tornDown++;
    }
  }
  const purge = await ctx.db
    .prepare("DELETE FROM handoff_csrf WHERE token_hash IN (SELECT token_hash FROM handoff_csrf WHERE expires_at < ? LIMIT ?)")
    .bind(ctx.now(), slice * 10)
    .run();
  result.csrfPurged = purge.meta.changes;
  return result;
}

/** Spread into 04's `scheduled/tasks.ts`: 4 queries per expired request, plus 2. */
export const PAIR_SWEEP_TASKS: readonly TaskDef[] = [
  {
    name: "pair_sweep", intervalS: 60, priority: 35, cost: { queries: SWEEP_SLICE * 4 + 2, subrequests: 0 },
    run: async (ctx) => {
      await runPairSweep(foundationCtx(ctx));
    },
  },
];
