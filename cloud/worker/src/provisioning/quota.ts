/**
 * Quota guard: refuses a provision that would exceed the account's Access app, reusable
 * policy or tunnel quota, and reports the quotas at 90% for 07's admin banner.
 *
 * The observation (`total_count` of each list) lives in the `cf_orphans` task's
 * `scheduled_tasks.cursor`, which that task refreshes hourly. P0 uses it while younger than
 * 60 min and otherwise refreshes it with three `per_page=1` list calls.
 *
 * - Every Access app in the org counts, not only yaran's; the refusal says so.
 * - Limits come from `Settings.quota_limits` (Enterprise accounts can raise Cloudflare's).
 *
 * <module-headers:begin>
 * Uses:
 * src/provisioning/quota.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/cloudflare/access.ts
 * ├── src/cloudflare/budget.ts
 * ├── src/cloudflare/tunnels.ts
 * ├── src/provisioning/ports.ts
 * ├── src/provisioning/provision-error.ts
 * ├── src/provisioning/settings.ts
 * └── src/reconcile/kit.ts
 * External: none
 *
 * Used by:
 * src/provisioning/quota.ts
 * ├── src/provisioning/index.ts
 * ├── src/provisioning/steps-provision.ts
 * ├── src/reconcile/orphans.ts
 * ├── test/provisioning/orphans.test.ts
 * └── test/provisioning/quota.test.ts
 * <module-headers:end>
 */
import type { Settings } from "@yaran/protocol";
import type { Priority } from "../cloudflare/budget.ts";
import { listApps, listPolicies } from "../cloudflare/access.ts";
import { listTunnels } from "../cloudflare/tunnels.ts";
import { readTaskCursor, writeTaskCursorStmts } from "../reconcile/kit.ts";
import { ProvisionError } from "./provision-error.ts";
import type { ProvCtx } from "./ports.ts";
import type { ProvSettings } from "./settings.ts";

export const QUOTA_MAX_AGE_SECONDS = 3600;
export const QUOTA_WARN_FRACTION = 0.9;
export const ORPHANS_TASK = "cf_orphans";

export interface QuotaObservation {
  apps_total: number;
  policies_total: number;
  tunnels_total: number;
  observed_at: number;
}

export type QuotaResource = keyof Settings["quota_limits"];

export interface QuotaUse {
  resource: QuotaResource;
  used: number;
  limit: number;
}

function uses(obs: QuotaObservation, limits: Settings["quota_limits"]): QuotaUse[] {
  return [
    { resource: "access_apps", used: obs.apps_total, limit: limits.access_apps },
    { resource: "access_policies", used: obs.policies_total, limit: limits.access_policies },
    { resource: "tunnels", used: obs.tunnels_total, limit: limits.tunnels },
  ];
}

/** The first quota one more machine would exceed, or null. */
export function quotaRefusal(obs: QuotaObservation, limits: Settings["quota_limits"]): QuotaUse | null {
  return uses(obs, limits).find((u) => u.used + 1 > u.limit) ?? null;
}

/** Quotas at or above 90%, for the admin console banner (07). */
export function quotaWarnings(obs: QuotaObservation, limits: Settings["quota_limits"]): QuotaUse[] {
  return uses(obs, limits).filter((u) => u.used >= Math.ceil(u.limit * QUOTA_WARN_FRACTION));
}

export function quotaMessage(u: QuotaUse): string {
  const what = { access_apps: "Access applications", access_policies: "reusable Access policies", tunnels: "Cloudflare Tunnels" }[u.resource];
  return (
    `The Cloudflare account already has ${u.used} of ${u.limit} ${what}, so another machine cannot be provisioned. ` +
    `Every ${what.replace(/s$/, "")} in the account counts, not only yaran's. Remove unused ones, or ask Cloudflare ` +
    `to raise the account limit and then raise quota_limits.${u.resource} in the admin console settings.`
  );
}

interface OrphansCursor {
  quota?: QuotaObservation;
}

export function readOrphansCursor(ctx: ProvCtx): Promise<Partial<OrphansCursor> & Record<string, unknown>> {
  return readTaskCursor<OrphansCursor & Record<string, unknown>>(ctx, ORPHANS_TASK);
}

/** Three `per_page=1` calls; `total_count` is the account-wide count. */
export async function observeQuota(ctx: ProvCtx, s: ProvSettings, priority: Priority): Promise<QuotaObservation> {
  const [apps, policies, tunnels] = [
    await listApps(ctx.cf, s.accountId, priority, 1),
    await listPolicies(ctx.cf, s.accountId, priority, 1),
    await listTunnels(ctx.cf, s.accountId, { per_page: 1, maxPages: 1 }, priority),
  ];
  return { apps_total: apps.total, policies_total: policies.total, tunnels_total: tunnels.total, observed_at: ctx.now() };
}

/** P0's guard: throws `account_quota_reached` (audited `quota.refused`) when a quota is full. */
export async function ensureQuota(ctx: ProvCtx, s: ProvSettings, machineId: string, priority: Priority): Promise<void> {
  const cursor = await readOrphansCursor(ctx);
  let obs = cursor.quota;
  const complete = !!obs && [obs.apps_total, obs.policies_total, obs.tunnels_total, obs.observed_at].every(Number.isFinite);
  if (!obs || !complete || ctx.now() - obs.observed_at >= QUOTA_MAX_AGE_SECONDS) {
    obs = await observeQuota(ctx, s, priority);
    await ctx.db.batch(writeTaskCursorStmts(ctx, ORPHANS_TASK, { ...cursor, quota: obs }));
  }
  const refusal = quotaRefusal(obs, s.quotaLimits);
  if (!refusal) return;
  await ctx.audit({
    action: "quota.refused",
    target: { kind: "machine", id: machineId },
    outcome: "failed",
    error_code: "account_quota_reached",
    detail: { ...refusal },
  });
  throw new ProvisionError("account_quota_reached", quotaMessage(refusal), { ...refusal });
}
