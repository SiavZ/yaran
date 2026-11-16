/**
 * Phase 07's jobs on 04's one-minute dispatcher: the update check and stale machines.
 *
 * Audit retention is not here: 07's `sweepAudit` is the body of 04's `purge_audit` task.
 * The stale job walks active machines a slice per run (cursor by id), moves each `revoke`
 * verdict to `revoking` with reason `stale` (05's `drive_ops` runs the ordered teardown),
 * and audits it as actor `system`; `notify` verdicts are badges computed when lists render.
 *
 * <module-headers:begin>
 * Uses:
 * src/admin/scheduled-jobs.ts
 * ├── src/admin/stale-policy.ts
 * ├── src/admin/wire-time.ts
 * ├── src/console/route-types.ts
 * ├── src/db/settings.ts
 * ├── src/provisioning/machine-rows.ts
 * ├── src/routes/phase07-context.ts
 * ├── src/scheduled/tasks.ts
 * └── src/update/update-checker.ts
 * External: none
 *
 * Used by:
 * src/admin/scheduled-jobs.ts
 * └── src/scheduled/tasks.ts
 * <module-headers:end>
 */
import { readContractSettings } from "../db/settings.ts";
import { markRevokingStmt } from "../provisioning/machine-rows.ts";
import { phase07Deps } from "../routes/phase07-context.ts";
import type { TaskDef } from "../scheduled/tasks.ts";
import type { Phase07Deps } from "../console/route-types.ts";
import { maybeCheckForUpdate } from "../update/update-checker.ts";
import { staleVerdict } from "./stale-policy.ts";
import { wireTime } from "./wire-time.ts";

export const STALE_SLICE = 15;

const iso = (s: number | null) => (s === null ? null : wireTime(new Date(s * 1000)));

/** One slice of the stale-machine sweep; `cursor` is null once every active machine was seen. */
export async function runStaleMachines(deps: Phase07Deps, after: string | null): Promise<{ revoked: string[]; cursor: string | null }> {
  const policy = (await readContractSettings(deps.db)).stale_machine_policy;
  if (policy.revoke_after_days === null) return { revoked: [], cursor: null };
  const { results: rows } = await deps.db
    .prepare("SELECT id, last_seen_at, claimed_at, created_at FROM machines WHERE status = 'active' AND id > ? ORDER BY id LIMIT ?")
    .bind(after ?? "", STALE_SLICE)
    .all<{ id: string; last_seen_at: number | null; claimed_at: number | null; created_at: number }>();
  const revoked: string[] = [];
  for (const m of rows) {
    if (staleVerdict(policy, iso(m.last_seen_at), iso(m.claimed_at ?? m.created_at)!, deps.now()) !== "revoke") continue;
    if ((await markRevokingStmt(deps.db, m.id, "stale", "system").run()).meta.changes !== 1) continue;
    await deps.audit({ actor: { kind: "system" }, action: "machine.revoked", target: { kind: "machine", id: m.id }, outcome: "ok", detail: { reason: "stale" } });
    revoked.push(m.id);
  }
  return { revoked, cursor: rows.length === STALE_SLICE ? rows[rows.length - 1]!.id : null };
}

/** Spread into 04's `scheduled/tasks.ts`. */
export const PHASE07_TASKS: readonly TaskDef[] = [
  {
    // Gated to hourly inside too; the GitHub manifest, release and asset fetches.
    name: "update_check", intervalS: 3600, priority: 80, cost: { queries: 4, subrequests: 3 },
    run: async (ctx) => void (await maybeCheckForUpdate(phase07Deps(ctx))),
  },
  {
    name: "stale_machines", intervalS: 86_400, priority: 70, cost: { queries: STALE_SLICE * 2 + 2, subrequests: 0 },
    run: async (ctx) => {
      const r = await runStaleMachines(phase07Deps(ctx), ctx.cursor);
      return { cursor: r.cursor, more: r.cursor !== null };
    },
  },
];
