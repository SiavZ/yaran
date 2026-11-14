/**
 * Desired state: pure builders for the four per-machine resources, and the comparators that
 * list how a live resource drifted from them.
 *
 * Provision, repair and the drift task all build from here, so "create" and "repair" can
 * never disagree about what a machine's policy, Access app, ingress and CNAME look like.
 *
 * - Comparators look only at the fields the builder sets; server-added fields (`id`,
 *   `created_at`, `aud`, `version`, …) never count as drift.
 * - Access is per ingress rule (`originRequest.access`), never tunnel-level (R16, G2 step 8);
 *   the top-level `originRequest` is always `{}`.
 * - No `httpHostHeader` (D4: a rewritten Host breaks yaran) and no timeouts (units
 *   UNVERIFIED, R4 §1.3). The service is `127.0.0.1`, not `localhost` (`::1` first).
 *
 * <module-headers:begin>
 * Uses:
 * src/cloudflare/desired.ts
 * ├── src/cloudflare/dns.ts
 * ├── src/cloudflare/types.ts
 * └── src/provisioning/naming.ts
 * External: none
 *
 * Used by:
 * src/cloudflare/desired.ts
 * ├── src/provisioning/steps-provision.ts
 * ├── src/reconcile/drift.ts
 * └── test/provisioning/desired.test.ts
 * <module-headers:end>
 */
import { appName, dnsComment, policyName } from "../provisioning/naming.ts";
import type { AccessAppRes, AccessPolicyRes, DnsRecordRes, TunnelConfig, TunnelConfigRes } from "./types.ts";
import type { DnsRecordBody } from "./dns.ts";

/**
 * `teamName` form inside `originRequest.access`: the team label (auth domain without
 * `.cloudflareaccess.com`) or the full auth domain. Gate G2 decides; this is the one switch.
 */
export type TeamNameForm = "label" | "domain";
export const TEAM_NAME_FORM: TeamNameForm = "label";

export interface DesiredInput {
  instanceId: string;
  machineId: string;
  hostname: string;
  ownerEmail: string;
}

export interface AppOptions {
  sessionDuration: string;
  sameSite: "lax" | "strict" | "none";
  /** G1 fallback L2 only: Managed OAuth redirect URIs; absent under L0/L1. */
  oauthAllowedUris?: readonly string[];
}

export function policyBody(m: DesiredInput) {
  return {
    name: policyName(m.instanceId, m.machineId),
    decision: "allow",
    include: [{ email: { email: m.ownerEmail } }],
  };
}

export function appBody(m: DesiredInput, policyId: string, o: AppOptions) {
  const body: Record<string, unknown> = {
    type: "self_hosted",
    name: appName(m.instanceId, m.machineId),
    domain: m.hostname,
    destinations: [{ type: "public", uri: m.hostname }],
    session_duration: o.sessionDuration,
    app_launcher_visible: false,
    enable_binding_cookie: false,
    http_only_cookie_attribute: true,
    same_site_cookie_attribute: o.sameSite,
    options_preflight_bypass: false,
    allow_iframe: false,
    policies: [{ id: policyId, precedence: 1 }],
  };
  if (o.oauthAllowedUris) {
    body["oauth_configuration"] = {
      enabled: true,
      dynamic_client_registration: {
        enabled: true,
        allowed_uris: [...o.oauthAllowedUris],
        allow_any_on_localhost: false,
        allow_any_on_loopback: false,
      },
      grant: { access_token_lifetime: "15m", session_duration: o.sessionDuration },
    };
  }
  return body;
}

/** G1 L2 redirect URIs: `/oauth/callback` on each `APP_CALLBACK_URLS` origin, plus the dev scheme. */
export function oauthAllowedUris(appCallbackUrls: readonly string[]): string[] {
  const origins = new Set<string>();
  for (const u of appCallbackUrls) {
    try {
      origins.add(new URL(u).origin);
    } catch {
      // An unparsable entry is 07's validation problem; it simply contributes nothing here.
    }
  }
  return [...[...origins].sort().map((o) => `${o}/oauth/callback`), "yaranapp://oauth/callback"];
}

export function teamNameFor(teamDomain: string, form: TeamNameForm = TEAM_NAME_FORM): string {
  return form === "label" ? teamDomain.replace(/\.cloudflareaccess\.com$/, "") : teamDomain;
}

export function ingressConfig(hostname: string, originPort: number, teamName: string, aud: string): TunnelConfig {
  return {
    ingress: [
      {
        hostname,
        service: `http://127.0.0.1:${originPort}`,
        originRequest: { access: { required: true, teamName, audTag: [aud] } },
      },
      { service: "http_status:404" },
    ],
    originRequest: {},
  };
}

export function dnsBody(m: DesiredInput, tunnelId: string): DnsRecordBody {
  return {
    type: "CNAME",
    name: m.hostname,
    content: `${tunnelId}.cfargotunnel.com`,
    proxied: true,
    ttl: 1,
    comment: dnsComment(m.instanceId, m.machineId),
  };
}

// --- Comparators ------------------------------------------------------------------------

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function diffFields(desired: Record<string, unknown>, live: Record<string, unknown>, prefix: string): string[] {
  return Object.keys(desired)
    .filter((k) => !same(desired[k], live[k]))
    .map((k) => `${prefix}.${k}`);
}

export function policyDrift(desired: ReturnType<typeof policyBody>, live: AccessPolicyRes): string[] {
  return diffFields(desired, { name: live.name, decision: live.decision, include: live.include }, "policy");
}

export function appDrift(desired: Record<string, unknown>, live: AccessAppRes): string[] {
  const projected: Record<string, unknown> = {
    ...live,
    domain: live.domain?.toLowerCase(),
    destinations: live.destinations?.map((d) => ({ type: d.type, uri: d.uri })),
    policies: live.policies?.map((p) => ({ id: p.id, precedence: p.precedence })),
  };
  // Managed OAuth is compared only when the builder emits it (G1 L2).
  return diffFields(desired, projected, "app");
}

export function ingressDrift(desired: TunnelConfig, live: TunnelConfigRes | null): string[] {
  const cfg = live?.config;
  if (!cfg) return ["ingress.missing"];
  const reasons: string[] = [];
  const [want, wantCatchAll] = desired.ingress;
  const [have, haveCatchAll, ...extra] = cfg.ingress ?? [];
  if (!have || have.hostname !== want?.hostname) reasons.push("ingress.hostname");
  if (have?.service !== want?.service) reasons.push("ingress.service");
  if (!same(have?.originRequest ?? {}, want?.originRequest ?? {})) reasons.push("ingress.originRequest");
  if (!haveCatchAll || haveCatchAll.service !== wantCatchAll?.service || haveCatchAll.hostname !== undefined || extra.length > 0) {
    reasons.push("ingress.catch_all");
  }
  if (!same(cfg.originRequest ?? {}, {})) reasons.push("ingress.tunnel_origin_request");
  return reasons;
}

export function dnsDrift(desired: DnsRecordBody, live: DnsRecordRes): string[] {
  return diffFields(
    desired as unknown as Record<string, unknown>,
    { ...live, name: live.name.toLowerCase(), comment: live.comment ?? null },
    "dns",
  );
}

/** The origin port the live ingress targets, or null when the service is not ours. */
export function liveOriginPort(live: TunnelConfigRes | null): number | null {
  const m = /^http:\/\/127\.0\.0\.1:(\d+)$/.exec(live?.config?.ingress?.[0]?.service ?? "");
  return m?.[1] ? Number(m[1]) : null;
}
