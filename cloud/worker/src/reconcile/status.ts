/**
 * `cf_status` task: keeps the machines' tunnel status cache fresh from one list call per run.
 *
 * Lists this instance's tunnels (`include_prefix=yaran-<inst>-`, one page of up to 1,000),
 * writes `cf_status`, `cf_status_at`, `conns_active_at` and `conns_inactive_at` only for rows
 * that changed, in one `batch()`, and pulls a live machine whose tunnel is missing to the
 * front of the drift queue. Marked tunnels no machine records are kept in this task's cursor
 * so the orphan sweep can judge them without another call.
 *
 * - Background priority: yields when the budget is under the reserve.
 * - About 3 D1 queries and 1 Cloudflare call per run.
 *
 * <module-headers:begin>
 * Uses:
 * src/reconcile/status.ts
 * ├── src/cloudflare/tunnels.ts
 * ├── src/provisioning/machine-rows.ts
 * ├── src/provisioning/naming.ts
 * ├── src/provisioning/ports.ts
 * ├── src/provisioning/settings.ts
 * ├── src/reconcile/drift.ts
 * └── src/reconcile/kit.ts
 * External: none
 *
 * Used by:
 * src/reconcile/status.ts
 * ├── src/provisioning/index.ts
 * ├── src/reconcile/orphans.ts
 * ├── src/reconcile/tasks.ts
 * ├── test/provisioning/orphans.test.ts
 * └── test/provisioning/status.test.ts
 * <module-headers:end>
 */
import { listTunnels } from "../cloudflare/tunnels.ts";
import { LIVE_STATUSES, type MachineStatus } from "../provisioning/machine-rows.ts";
import { markerPrefix } from "../provisioning/naming.ts";
import type { ProvCtx } from "../provisioning/ports.ts";
import { loadProvSettings } from "../provisioning/settings.ts";
import { pullDriftForwardStmts } from "./drift.ts";
import { writeTaskCursorStmts, yieldingToBudget, type TaskOutcome } from "./kit.ts";

export const STATUS_TASK = "cf_status";

export interface StatusCursor {
  /** Marked tunnels that no machine row records (orphan candidates). */
  others: Array<{ id: string; name: string }>;
  tunnels_total: number;
  observed_at: number;
}

interface Row {
  id: string;
  status: MachineStatus;
  tunnel_id: string;
  cf_status: string | null;
  conns_active_at: string | null;
  conns_inactive_at: string | null;
}

export function runCfStatus(ctx: ProvCtx): Promise<TaskOutcome> {
  return yieldingToBudget(STATUS_TASK, ctx, async () => {
    const s = await loadProvSettings(ctx);
    ctx.cf.budget.backgroundReserve = s.apiBackgroundReserve;
    const now = ctx.now();
    const { items, total } = await listTunnels(
      ctx.cf,
      s.accountId,
      { include_prefix: markerPrefix("tunnel", s.instanceId), per_page: 1000, maxPages: 1 },
      "background",
    );
    const byId = new Map(items.map((t) => [t.id, t]));
    const { results: rows } = await ctx.db
      .prepare(
        "SELECT id, status, tunnel_id, cf_status, conns_active_at, conns_inactive_at FROM machines WHERE tunnel_id IS NOT NULL AND status IN ('provisioning','awaiting_claim','active','revoking')",
      )
      .all<Row>();
    const stmts = [];
    const missing: string[] = [];
    for (const row of rows) {
      const t = byId.get(row.tunnel_id);
      const next = t
        ? { status: t.status ?? "unknown", active: t.conns_active_at ?? null, inactive: t.conns_inactive_at ?? null }
        : { status: "unknown", active: row.conns_active_at, inactive: row.conns_inactive_at };
      if (!t && LIVE_STATUSES.includes(row.status)) missing.push(row.id);
      if (next.status === row.cf_status && next.active === row.conns_active_at && next.inactive === row.conns_inactive_at) continue;
      stmts.push(
        ctx.db
          .prepare("UPDATE machines SET cf_status = ?, cf_status_at = ?, conns_active_at = ?, conns_inactive_at = ? WHERE id = ?")
          .bind(next.status, now, next.active, next.inactive, row.id),
      );
    }
    const changed = stmts.length;
    const known = new Set(rows.map((r) => r.tunnel_id));
    const cursor: StatusCursor = {
      others: items.filter((t) => !known.has(t.id)).map((t) => ({ id: t.id, name: t.name })),
      tunnels_total: total,
      observed_at: now,
    };
    stmts.push(...writeTaskCursorStmts(ctx, STATUS_TASK, cursor));
    if (missing.length > 0) stmts.push(...(await pullDriftForwardStmts(ctx, missing)));
    await ctx.db.batch(stmts);
    return { ok: true, note: `${changed} machine tunnel statuses changed; ${missing.length} live machines have no tunnel` };
  });
}
