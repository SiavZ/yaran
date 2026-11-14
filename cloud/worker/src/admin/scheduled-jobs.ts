/**
 * Phase 07's jobs on the shared one-minute cron: update check, stale machines, audit retention.
 *
 * Each job gates itself on its own interval (a day), so registering it with 04's task
 * registry costs no extra cron slot. The stale-machine job asks `staleVerdict` per machine
 * and tears down `revoke` verdicts through 05 with reason `stale`, audited as actor
 * `system`; `notify` verdicts are badges computed when the lists render.
 *
 * - The retention sweep is the body of 04's `purge_audit` task, fed with the setting.
 *
 * <module-headers:begin>
 * Uses:
 * src/admin/scheduled-jobs.ts
 * ├── src/admin/audit-query.ts
 * ├── src/admin/settings-schema.ts
 * ├── src/admin/stale-policy.ts
 * ├── src/console/route-types.ts
 * └── src/update/update-checker.ts
 * External: none
 *
 * Used by:
 * src/admin/scheduled-jobs.ts
 * └── src/phase07.ts
 * <module-headers:end>
 */
import type { Phase07Deps } from "../console/route-types.ts";
import { maybeCheckForUpdate } from "../update/update-checker.ts";
import { sweepAudit } from "./audit-query.ts";
import { readSettings } from "./settings-schema.ts";
import { staleVerdict } from "./stale-policy.ts";

export interface Phase07Task {
  /** The row name in 04's `scheduled_tasks`. */
  name: "update_check" | "stale_machines" | "purge_audit";
  intervalMinutes: number;
  run(deps: Phase07Deps): Promise<void>;
}

export async function runStaleMachines(deps: Phase07Deps): Promise<string[]> {
  const policy = (await readSettings(deps.db)).stale_machine_policy;
  const revoked: string[] = [];
  let cursor: string | null = null;
  do {
    const page: Awaited<ReturnType<typeof deps.pairing.listMachines>> = await deps.pairing.listMachines({ cursor, limit: 100 });
    for (const m of page.items) {
      if (staleVerdict(policy, m.last_seen_at, m.paired_at, deps.now()) !== "revoke") continue;
      await deps.provisioning.startTeardown(m.id, "stale");
      await deps.audit({ actor: { kind: "system" }, action: "machine.revoked", target: { kind: "machine", id: m.id }, outcome: "ok", detail: { reason: "stale" } });
      revoked.push(m.id);
    }
    cursor = page.next_cursor;
  } while (cursor);
  return revoked;
}

export const PHASE07_TASKS: readonly Phase07Task[] = [
  { name: "update_check", intervalMinutes: 60, run: async (deps) => void (await maybeCheckForUpdate(deps)) },
  { name: "stale_machines", intervalMinutes: 24 * 60, run: async (deps) => void (await runStaleMachines(deps)) },
  { name: "purge_audit", intervalMinutes: 24 * 60, run: async (deps) => void (await sweepAudit(deps.db, (await readSettings(deps.db)).audit_retention_days, deps.now())) },
];
