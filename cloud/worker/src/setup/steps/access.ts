/**
 * Wizard step 5 (and the pairing-policy setting): the control-plane Access app and policy.
 *
 * Creates or updates the reusable policy "yaran users" from `Settings.pairing_policy`
 * (the admin's email always included), then the self-hosted control-plane app with exactly
 * two public overrides, `/v1/meta` and `/v1/machine/*`, HttpOnly + SameSite=Lax cookies and
 * the binding cookie off (gate G8 primary). If Cloudflare rejects overrides, it falls back
 * to two path apps under a reusable bypass policy (G8 option B). Every object is found by
 * name before it is created, so a re-run after a partial failure never duplicates one.
 *
 * - `mode: everyone` is refused while a One-time PIN IdP is enabled (it would admit any
 *   address that can receive mail).
 *
 * <module-headers:begin>
 * Uses:
 * src/setup/steps/access.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/admin/ports.ts
 * ├── src/cloudflare/setup-endpoints.ts
 * └── src/setup/wizard-state.ts
 * External: none
 *
 * Used by:
 * src/setup/steps/access.ts
 * ├── src/admin/health.ts
 * ├── src/admin/settings-apply.ts
 * ├── src/setup/routes.ts
 * └── test/setup-steps.test.ts
 * <module-headers:end>
 */
import type { Settings } from "@yaran/protocol";
import { assertNever, isCfApiError, type CfTransport } from "../../admin/ports.ts";
import { access, idp, type CfAccessApp, type CfPolicy } from "../../cloudflare/setup-endpoints.ts";
import type { SetupEvent } from "../wizard-state.ts";

export const POLICY_NAME = "yaran users";
export const BYPASS_POLICY_NAME = "yaran public paths";
export const APP_NAME = "yaran control plane";
export const PUBLIC_PATHS = ["/v1/meta", "/v1/machine/*"] as const;
const BYPASS_PATHS = ["/v1/meta", "/v1/machine/"] as const;

/** `pairing_policy` → Access `include` rules. */
export function policyInclude(policy: Settings["pairing_policy"], adminEmail: string): unknown[] {
  switch (policy.mode) {
    case "everyone":
      return [{ everyone: {} }];
    case "allowlist": {
      const emails = [...new Set([adminEmail.toLowerCase(), ...policy.emails.map((e) => e.toLowerCase())])];
      return [
        ...emails.map((email) => ({ email: { email } })),
        ...policy.domains.map((domain) => ({ email_domain: { domain } })),
        ...policy.access_group_ids.map((id) => ({ group: { id } })),
      ];
    }
    default:
      return assertNever(policy.mode);
  }
}

/** True when saving `mode: everyone` must be refused: a One-time PIN IdP is enabled. */
export async function everyoneRefused(cf: CfTransport, accountId: string, policy: Settings["pairing_policy"]): Promise<boolean> {
  if (policy.mode !== "everyone") return false;
  return (await idp.list(cf, accountId)).some((p) => p.type === "onetimepin");
}

export function controlPlaneAppBody(host: string, sessionDuration: string, policyId: string, withOverrides: boolean): Record<string, unknown> {
  const destination: Record<string, unknown> = { type: "public", uri: host };
  if (withOverrides) destination.overrides = PUBLIC_PATHS.map((path_pattern) => ({ behavior: "public", path_pattern }));
  return {
    name: APP_NAME,
    type: "self_hosted",
    domain: host,
    destinations: [destination],
    session_duration: sessionDuration,
    http_only_cookie_attribute: true,
    same_site_cookie_attribute: "lax",
    enable_binding_cookie: false,
    app_launcher_visible: false,
    policies: [{ id: policyId, precedence: 1 }],
  };
}

async function upsertPolicy(cf: CfTransport, accountId: string, name: string, body: Record<string, unknown>): Promise<CfPolicy> {
  const existing = (await access.listPolicies(cf, accountId)).find((p) => p.name === name);
  return existing ? access.updatePolicy(cf, accountId, existing.id, body) : access.createPolicy(cf, accountId, body);
}

async function upsertApp(cf: CfTransport, accountId: string, apps: CfAccessApp[], body: Record<string, unknown>): Promise<CfAccessApp> {
  const existing = apps.find((a) => a.name === body.name);
  return existing ? access.updateApp(cf, accountId, existing.id, body) : access.createApp(cf, accountId, body);
}

/** Rewrites the "yaran users" policy from the pairing policy; used by setup and by Settings. */
export function applyPairingPolicy(cf: CfTransport, accountId: string, policy: Settings["pairing_policy"], adminEmail: string): Promise<CfPolicy> {
  return upsertPolicy(cf, accountId, POLICY_NAME, { name: POLICY_NAME, decision: "allow", include: policyInclude(policy, adminEmail) });
}

export interface AccessInput {
  accountId: string;
  host: string;
  adminEmail: string;
  sessionDuration: string;
  pairingPolicy: Settings["pairing_policy"];
}

export async function ensureAccess(cf: CfTransport, i: AccessInput): Promise<SetupEvent> {
  const policy = await applyPairingPolicy(cf, i.accountId, i.pairingPolicy, i.adminEmail);
  const apps = await access.listApps(cf, i.accountId);
  try {
    const app = await upsertApp(cf, i.accountId, apps, controlPlaneAppBody(i.host, i.sessionDuration, policy.id, true));
    return { kind: "access_ready", policy_id: policy.id, access_app_id: app.id, access_aud: app.aud, public_paths_mode: "overrides", bypass_app_ids: [] };
  } catch (e) {
    if (!(isCfApiError(e) && e.kind === "invalid")) throw e;
  }
  // G8 fallback: the main app without overrides, plus one bypass path app per public path.
  const app = await upsertApp(cf, i.accountId, apps, controlPlaneAppBody(i.host, i.sessionDuration, policy.id, false));
  const bypass = await upsertPolicy(cf, i.accountId, BYPASS_POLICY_NAME, { name: BYPASS_POLICY_NAME, decision: "bypass", include: [{ everyone: {} }] });
  const ids: string[] = [];
  for (const path of BYPASS_PATHS) {
    const pathApp = await upsertApp(cf, i.accountId, apps, {
      name: `${APP_NAME} ${path}`,
      type: "self_hosted",
      domain: `${i.host}${path}`,
      app_launcher_visible: false,
      policies: [{ id: bypass.id, precedence: 1 }],
    });
    ids.push(pathApp.id);
  }
  return { kind: "access_ready", policy_id: policy.id, access_app_id: app.id, access_aud: app.aud, public_paths_mode: "bypass_apps", bypass_app_ids: ids };
}
