/**
 * Wizard step 3: the Zero Trust organization and its team domain.
 *
 * Reads the organization's `auth_domain` as the team domain. With no organization, offers
 * to create one by API (gate G10); when Cloudflare refuses (Zero Trust onboarding needs a
 * payment method even on the Free plan), the page shows the dashboard path and Check again.
 *
 * <module-headers:begin>
 * Uses:
 * src/setup/steps/org.ts
 * ├── src/admin/ports.ts
 * ├── src/cloudflare/setup-endpoints.ts
 * └── src/setup/wizard-state.ts
 * External: none
 *
 * Used by:
 * src/setup/steps/org.ts
 * ├── src/setup/routes.ts
 * └── test/setup-steps.test.ts
 * <module-headers:end>
 */
import { isCfApiError, type CfTransport } from "../../admin/ports.ts";
import { org } from "../../cloudflare/setup-endpoints.ts";
import type { SetupEvent } from "../wizard-state.ts";

export type OrgOutcome = { ok: true; event: SetupEvent } | { ok: false; problem: "no_org" | "onboarding_required" | "invalid_team_name" };

const TEAM_DOMAIN = /^[a-z0-9-]+\.(fed\.)?cloudflareaccess\.com$/;
const TEAM_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

function fromOrg(authDomain: string | undefined): OrgOutcome | undefined {
  if (authDomain && TEAM_DOMAIN.test(authDomain)) return { ok: true, event: { kind: "team_domain", team_domain: authDomain } };
  return undefined;
}

export async function readOrg(cf: CfTransport, accountId: string): Promise<OrgOutcome> {
  try {
    return fromOrg((await org.get(cf, accountId)).auth_domain) ?? { ok: false, problem: "no_org" };
  } catch (e) {
    if (isCfApiError(e) && e.kind === "not_found") return { ok: false, problem: "no_org" };
    throw e;
  }
}

export async function createOrg(cf: CfTransport, accountId: string, teamName: string, orgName: string): Promise<OrgOutcome> {
  if (!TEAM_NAME.test(teamName)) return { ok: false, problem: "invalid_team_name" };
  try {
    const created = await org.create(cf, accountId, orgName, `${teamName}.cloudflareaccess.com`);
    return fromOrg(created.auth_domain) ?? { ok: false, problem: "onboarding_required" };
  } catch (e) {
    if (isCfApiError(e) && (e.kind === "auth" || e.kind === "invalid" || e.kind === "conflict")) return { ok: false, problem: "onboarding_required" };
    throw e;
  }
}
