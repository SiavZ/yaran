/**
 * The admin Health page's checks: is the control plane still wired the way setup left it?
 *
 * Re-reads Cloudflare: the control-plane Access app and its two public paths (overrides,
 * or the G8 bypass path apps, whichever setup put in force), the "yaran users" policy, the
 * custom domain, the workers.dev subdomain, the sign-in methods; and quota use against
 * `quota_limits`, plus the last reconciliation run. A check that could not be read says
 * "unknown", never "ok".
 *
 * - Read-only; the Disable workers.dev retry lives here too.
 */
import type { Phase07Deps } from "../console/route-types.ts";
import { access, idp, workers } from "../cloudflare/setup-endpoints.ts";
import { disableWorkersDev } from "../setup/steps/claim.ts";
import { APP_NAME, POLICY_NAME, PUBLIC_PATHS } from "../setup/steps/access.ts";
import { loadRecord } from "../setup/steps/common.ts";
import { usableIdps } from "../setup/steps/idp.ts";
import { storedCf } from "./api-token.ts";
import { readSettings } from "./settings-schema.ts";
import { writeKeys } from "./settings-store.ts";

export type CheckId = "access_app" | "public_paths" | "policy" | "custom_domain" | "workers_dev_off" | "idps" | "quota_apps" | "quota_policies" | "quota_tunnels" | "reconcile";

export interface HealthCheck {
  id: CheckId;
  ok: boolean | null;
  detail: string;
}

async function attempt<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

function quota(id: CheckId, used: number | null, limit: number, what: string): HealthCheck {
  if (used === null) return { id, ok: null, detail: `Could not count ${what}.` };
  return { id, ok: used < limit * 0.9, detail: `${used} of ${limit} ${what} used${used >= limit * 0.9 ? "; above 90%, raise the limit with Cloudflare before it runs out" : ""}.` };
}

export async function runHealthChecks(deps: Phase07Deps): Promise<HealthCheck[]> {
  const r = await loadRecord(deps.db);
  const s = await readSettings(deps.db);
  const cf = await storedCf(deps);
  const acct = r.account_id!;
  const [apps, policies, domains, sub, idps] = await Promise.all([
    attempt(() => access.listApps(cf, acct)),
    attempt(() => access.listPolicies(cf, acct)),
    attempt(() => workers.listDomains(cf, acct, r.cp_host!)),
    attempt(() => workers.getSubdomain(cf, acct, r.script_name!)),
    attempt(() => idp.list(cf, acct)),
  ]);
  const app = apps?.find((a) => a.id === r.access_app_id || a.name === APP_NAME);
  const overrides = app?.destinations?.flatMap((d) => d.overrides ?? []).map((o) => o.path_pattern).sort() ?? [];
  const pathsOk =
    r.public_paths_mode === "bypass_apps"
      ? (r.bypass_app_ids ?? []).every((id) => apps?.some((a) => a.id === id))
      : JSON.stringify(overrides) === JSON.stringify([...PUBLIC_PATHS].sort());
  const tunnels = await attempt(() => deps.db.prepare("SELECT count(*) AS n FROM machines WHERE revoked_at IS NULL").first<{ n: number }>());
  const recon = await attempt(() => deps.db.prepare("SELECT max(last_ok_at) AS at FROM scheduled_tasks WHERE task LIKE 'cf_%'").first<{ at: number | null }>());
  const usable = idps ? usableIdps(idps) : null;
  return [
    { id: "access_app", ok: apps ? !!app : null, detail: app ? "The control-plane Access application exists." : "The control-plane Access application is missing; re-run setup's Access step from a fresh deploy or recreate it in Zero Trust." },
    { id: "public_paths", ok: apps ? !!app && pathsOk : null, detail: r.public_paths_mode === "bypass_apps" ? "Public paths use bypass path applications." : `Public overrides: ${overrides.join(", ") || "none"}.` },
    { id: "policy", ok: policies ? policies.some((p) => p.name === POLICY_NAME) : null, detail: `The reusable policy ${POLICY_NAME}.` },
    { id: "custom_domain", ok: domains ? domains.some((d) => d.hostname === r.cp_host) : null, detail: `Custom domain ${r.cp_host}.` },
    { id: "workers_dev_off", ok: sub ? !sub.enabled : null, detail: sub?.enabled ? "The workers.dev address is still enabled. It refuses every request, but turn it off." : "The workers.dev address is off." },
    { id: "idps", ok: usable ? usable.length > 0 : null, detail: usable ? `Sign-in methods: ${usable.map((p) => p.name).join(", ") || "none besides Cloudflare account login"}.` : "Could not list sign-in methods." },
    quota("quota_apps", apps?.length ?? null, s.quota_limits.access_apps, "Access applications"),
    quota("quota_policies", policies?.length ?? null, s.quota_limits.access_policies, "Access policies"),
    quota("quota_tunnels", tunnels ? Number(tunnels.n) : null, s.quota_limits.tunnels, "yaran tunnels"),
    { id: "reconcile", ok: recon?.at ? true : null, detail: recon?.at ? `Last reconciliation ${new Date(recon.at * 1000).toISOString()}.` : "No reconciliation run recorded yet." },
  ];
}

/** The Health page's Disable workers.dev retry. */
export async function retryDisableWorkersDev(deps: Phase07Deps, actorId: string): Promise<boolean> {
  const r = await loadRecord(deps.db);
  const ok = await disableWorkersDev(await storedCf(deps), r.account_id!, r.script_name!);
  if (ok) await writeKeys(deps.db, { workers_dev_disabled: true }, actorId, deps.now());
  await deps.audit({ actor: { kind: "admin", id: actorId }, action: "settings.updated", target: { kind: "settings" }, outcome: ok ? "ok" : "failed", detail: { changed: ["workers_dev"] } });
  return ok;
}
