/**
 * Wizard step 6: attach the control-plane custom domain by API (gate G14).
 *
 * Runs only after the Access app exists (the reducer orders it), so the hostname is never
 * reachable without Access. Attaching is idempotent: an existing attachment to this script
 * counts as done. When the API or the permission is refused, the page shows the dashboard
 * path and Check again looks the hostname up.
 *
 * - Certificate readiness is not read from the API (its field is UNVERIFIED, G14); opening
 *   the claim link on the new hostname proves it end to end.
 *
 * <module-headers:begin>
 * Uses:
 * src/setup/steps/domain.ts
 * ├── src/admin/ports.ts
 * ├── src/cloudflare/setup-endpoints.ts
 * └── src/setup/wizard-state.ts
 * External: none
 *
 * Used by:
 * src/setup/steps/domain.ts
 * ├── src/setup/routes.ts
 * └── test/setup-steps.test.ts
 * <module-headers:end>
 */
import { isCfApiError, type CfTransport } from "../../admin/ports.ts";
import { workers } from "../../cloudflare/setup-endpoints.ts";
import type { SetupEvent } from "../wizard-state.ts";

export type DomainOutcome = { ok: true; event: SetupEvent } | { ok: false; problem: "dashboard_required" | "not_found_yet" | "taken_by_other_worker" };

export interface DomainInput {
  accountId: string;
  host: string;
  zoneId: string;
  script: string;
}

async function existing(cf: CfTransport, i: DomainInput): Promise<"ours" | "other" | "none"> {
  const found = (await workers.listDomains(cf, i.accountId, i.host)).find((d) => d.hostname === i.host);
  if (!found) return "none";
  return found.service === i.script ? "ours" : "other";
}

export async function attachDomain(cf: CfTransport, i: DomainInput): Promise<DomainOutcome> {
  const state = await existing(cf, i);
  if (state === "ours") return { ok: true, event: { kind: "domain_attached", domain_mode: "api" } };
  if (state === "other") return { ok: false, problem: "taken_by_other_worker" };
  try {
    await workers.attachDomain(cf, i.accountId, { hostname: i.host, service: i.script, zone_id: i.zoneId });
    return { ok: true, event: { kind: "domain_attached", domain_mode: "api" } };
  } catch (e) {
    if (isCfApiError(e) && (e.kind === "auth" || e.kind === "invalid")) return { ok: false, problem: "dashboard_required" };
    throw e;
  }
}

/** Check again after the admin attached the domain in the dashboard. */
export async function checkDomain(cf: CfTransport, i: DomainInput): Promise<DomainOutcome> {
  const state = await existing(cf, i);
  if (state === "ours") return { ok: true, event: { kind: "domain_attached", domain_mode: "dashboard" } };
  return { ok: false, problem: state === "other" ? "taken_by_other_worker" : "not_found_yet" };
}
