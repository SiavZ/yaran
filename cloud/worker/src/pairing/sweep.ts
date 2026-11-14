/**
 * The pairing sweep: expires pair requests past their 10 minutes, tears down the
 * `awaiting_claim` (or still provisioning) machines they left behind through 05's ordered
 * teardown (D21), and purges expired handoff csrf rows.
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
 * └── src/seams/context.ts
 * External: none
 *
 * Used by:
 * src/pairing/sweep.ts
 * ├── test/pairing/audit-coverage.test.ts
 * └── test/pairing/pair-requests.test.ts
 * <module-headers:end>
 */
import { getMachine } from "../machines/machine-rows.ts";
import type { Phase06Ctx } from "../seams/context.ts";
import { dueForExpiry, expire } from "./pair-requests.ts";

export const SWEEP_SLICE = 20;

export interface SweepResult {
  expired: number;
  tornDown: number;
  csrfPurged: number;
}

export async function runPairSweep(ctx: Phase06Ctx, slice = SWEEP_SLICE): Promise<SweepResult> {
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
      await ctx.provisioning.startTeardown(machine.id, "stale");
      result.tornDown++;
    }
  }
  const purge = await ctx.db
    .prepare("DELETE FROM handoff_csrf WHERE token_hash IN (SELECT token_hash FROM handoff_csrf WHERE expires_at < ? LIMIT ?)")
    .bind(ctx.now(), slice * 10)
    .run();
  result.csrfPurged = purge.meta.changes;
  return result;
}

/** The row Phase 04's `scheduled/tasks.ts` registry appends (assumed shape). */
export const PAIR_SWEEP_TASK = { task: "pair_sweep", intervalS: 60, run: (ctx: Phase06Ctx) => runPairSweep(ctx) } as const;
