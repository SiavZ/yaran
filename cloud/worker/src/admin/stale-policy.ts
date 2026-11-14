/**
 * Stale-machine verdict: keep, notify or revoke a machine from how long it has been offline.
 *
 * Phase 05's reconciliation cron asks this for every machine. `notify` puts a badge on the
 * user's and the admin's machine lists; `revoke` makes the caller run 05's teardown with
 * reason `stale`, audited with actor `system`. A `null` threshold means that rung is off.
 *
 * - Pure: the caller passes the clock.
 * - A machine never seen (no last_seen_at) counts from when it was paired.
 *
 * <module-headers:begin>
 * Uses:
 * src/admin/stale-policy.ts
 * └── @yaran/protocol:src/index.ts
 * External: none
 *
 * Used by:
 * src/admin/stale-policy.ts
 * ├── src/admin/scheduled-jobs.ts
 * ├── src/console/routes.ts
 * └── test/stale-policy.test.ts
 * <module-headers:end>
 */
import type { Settings } from "@yaran/protocol";

export type StaleVerdict = "keep" | "notify" | "revoke";

const DAY_MS = 86_400_000;

export function staleVerdict(
  policy: Settings["stale_machine_policy"],
  lastSeenAt: string | null | undefined,
  pairedAt: string,
  now: Date,
): StaleVerdict {
  const since = Date.parse(lastSeenAt ?? pairedAt);
  if (Number.isNaN(since)) return "keep";
  const offlineDays = (now.getTime() - since) / DAY_MS;
  if (policy.revoke_after_days !== null && offlineDays >= policy.revoke_after_days) return "revoke";
  if (policy.notify_after_days !== null && offlineDays >= policy.notify_after_days) return "notify";
  return "keep";
}
