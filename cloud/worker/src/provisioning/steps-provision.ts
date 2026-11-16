/**
 * Provision steps P0-P6: preflight, policy, Access app, tunnel, ingress, DNS, finalize.
 *
 * The order is the point (D21): everything that protects the hostname exists before the DNS
 * record that publishes it, so the hostname is never reachable without Access in front.
 * `repair` reuses P1-P5 on a live machine, and a P4-only repair applies a new origin port.
 *
 * - Each create step: recorded id → GET (repair drift with a PUT/PATCH, or fall through on
 *   404); intent present → adopt by marker; else write the intent and POST.
 * - A resource without this instance's marker is never adopted or modified: finding one at
 *   our hostname is a permanent `hostname_conflict`.
 * - A new tunnel replacing a recorded one bumps `tunnel_secret_generation` (wire
 *   `token_version`), so yaran fetches the new token through W7 `sync`.
 *
 * <module-headers:begin>
 * Uses:
 * src/provisioning/steps-provision.ts
 * ├── src/cloudflare/access.ts
 * ├── src/cloudflare/desired.ts
 * ├── src/cloudflare/dns.ts
 * ├── src/cloudflare/errors.ts
 * ├── src/cloudflare/tunnels.ts
 * ├── src/provisioning/engine.ts
 * ├── src/provisioning/machine-rows.ts
 * ├── src/provisioning/naming.ts
 * ├── src/provisioning/ops-store.ts
 * ├── src/provisioning/provision-error.ts
 * ├── src/provisioning/quota.ts
 * └── src/provisioning/settings.ts
 * External: none
 *
 * Used by:
 * src/provisioning/steps-provision.ts
 * ├── src/provisioning/engine.ts
 * ├── src/provisioning/steps-teardown.ts
 * └── src/reconcile/drift.ts
 * <module-headers:end>
 */
import {
  createApp,
  createPolicy,
  findAppsByDomain,
  getApp,
  getPolicy,
  listPolicies,
  replaceApp,
  replacePolicy,
} from "../cloudflare/access.ts";
import {
  appBody,
  appDrift,
  dnsBody,
  dnsDrift,
  ingressConfig,
  oauthAllowedUris,
  policyBody,
  policyDrift,
  teamNameFor,
  type AppOptions,
  type DesiredInput,
} from "../cloudflare/desired.ts";
import { createDnsRecord, findDnsByName, getDnsRecord, patchDnsRecord } from "../cloudflare/dns.ts";
import { CfApiError } from "../cloudflare/errors.ts";
import { createTunnel, findTunnelByName, getTunnel, putTunnelConfig } from "../cloudflare/tunnels.ts";
import type { StepCtx, StepFn, StepOutcome } from "./engine.ts";
import { markAwaitingClaim, type MachineRow } from "./machine-rows.ts";
import { appName, deriveHostname, dnsComment, MAX_HOSTNAME_CANDIDATES, tunnelName } from "./naming.ts";
import type { ProvisionStep } from "./ops-store.ts";
import { ProvisionError } from "./provision-error.ts";
import { ensureQuota } from "./quota.ts";
import type { ProvSettings } from "./settings.ts";

/** Runs `get`, mapping a 404 to null ("already gone"; the caller recreates). */
export async function orNull<T>(get: () => Promise<T>): Promise<T | null> {
  try {
    return await get();
  } catch (err) {
    if (err instanceof CfApiError && err.kind === "not_found") return null;
    throw err;
  }
}

export function desiredInput(s: ProvSettings, m: MachineRow): DesiredInput {
  if (!m.hostname) throw new ProvisionError("provisioning_failed", "machine has no hostname yet; preflight must run first");
  return { instanceId: s.instanceId, machineId: m.id, hostname: m.hostname, ownerEmail: m.owner_email };
}

export function appOptions(s: ProvSettings, appCallbackUrls: readonly string[]): AppOptions {
  const o: AppOptions = { sessionDuration: s.sessionDuration, sameSite: s.machineSameSite };
  if (s.machineManagedOauth) o.oauthAllowedUris = oauthAllowedUris(appCallbackUrls);
  return o;
}

function conflict(host: string, what: string): ProvisionError {
  return new ProvisionError("hostname_conflict", `${host} is already used by ${what} that this yaran control plane does not own`, { hostname: host });
}

/** Whether a candidate hostname is free for this machine; throws nothing for "taken". */
async function hostnameFree(sc: StepCtx, host: string): Promise<boolean> {
  const { ctx, s, m, priority } = sc;
  const label = host.slice(0, host.indexOf("."));
  if (s.controlPlaneHost === host || s.controlPlaneHost.split(".")[0] === label) return false;
  const held = await ctx.db.prepare("SELECT 1 AS x FROM machines WHERE hostname = ? AND id <> ?").bind(host, m.id).first();
  if (held) return false;
  const ours = dnsComment(s.instanceId, m.id);
  const records = await findDnsByName(ctx.cf, s.zoneId, host, priority);
  if (records.some((r) => r.comment !== ours)) return false;
  const apps = await findAppsByDomain(ctx.cf, s.accountId, host, priority);
  return !apps.some((a) => a.name !== appName(s.instanceId, m.id));
}

const preflight: StepFn = async (sc) => {
  const { ctx, s, m, priority } = sc;
  await ensureQuota(ctx, s, m.id, priority);
  if (m.hostname) {
    // A persisted hostname is re-checked, never re-derived.
    if (!(await hostnameFree(sc, m.hostname))) throw conflict(m.hostname, "a DNS record or Access application");
    return {};
  }
  for (let n = 1; n <= MAX_HOSTNAME_CANDIDATES; n++) {
    const host = deriveHostname(m.slug, m.owner_slug, s.zoneName, n);
    if (await hostnameFree(sc, host)) return { patch: { hostname: host } };
  }
  throw new ProvisionError(
    "hostname_conflict",
    `no free hostname for machine ${m.slug} after ${MAX_HOSTNAME_CANDIDATES} candidates; rename the machine and pair again`,
    { machine: m.slug },
  );
};

const policy: StepFn = async (sc) => {
  const { ctx, s, m, priority } = sc;
  const desired = policyBody(desiredInput(sc.s, sc.m));
  if (m.access_policy_id) {
    const live = await orNull(() => getPolicy(ctx.cf, s.accountId, m.access_policy_id as string, priority));
    if (live) {
      if (policyDrift(desired, live).length > 0) await replacePolicy(ctx.cf, s.accountId, live.id, desired, priority);
      return {};
    }
  }
  let found = sc.hadIntent ? (await listPolicies(ctx.cf, s.accountId, priority)).items.find((p) => p.name === desired.name) : undefined;
  if (!found) {
    await sc.markIntent();
    found = await createPolicy(ctx.cf, s.accountId, desired, priority);
  }
  return { patch: { access_policy_id: found.id } };
};

const app: StepFn = async (sc) => {
  const { ctx, s, m, priority } = sc;
  const input = desiredInput(sc.s, sc.m);
  if (!m.access_policy_id) throw new ProvisionError("provisioning_failed", "Access app step reached without a policy");
  const desired = appBody(input, m.access_policy_id, appOptions(sc.s, sc.ctx.appCallbackUrls));
  if (m.access_app_id) {
    const live = await orNull(() => getApp(ctx.cf, s.accountId, m.access_app_id as string, priority));
    if (live) {
      if (appDrift(desired, live).length > 0) await replaceApp(ctx.cf, s.accountId, live.id, desired, priority);
      return { patch: { access_app_aud: live.aud } };
    }
  }
  const byDomain = sc.hadIntent ? await findAppsByDomain(ctx.cf, s.accountId, input.hostname, priority) : [];
  let found = byDomain.find((a) => a.name === desired["name"]);
  if (!found) {
    await sc.markIntent();
    found = await createApp(ctx.cf, s.accountId, desired, priority);
  }
  return { patch: { access_app_id: found.id, access_app_aud: found.aud } };
};

const tunnel: StepFn = async (sc) => {
  const { ctx, s, m, priority } = sc;
  const name = tunnelName(s.instanceId, m.id);
  if (m.tunnel_id) {
    const live = await orNull(() => getTunnel(ctx.cf, s.accountId, m.tunnel_id as string, priority));
    if (live && !live.deleted_at) return {};
  }
  let found = sc.hadIntent ? await findTunnelByName(ctx.cf, s.accountId, name, priority) : null;
  if (!found) {
    await sc.markIntent();
    try {
      found = await createTunnel(ctx.cf, s.accountId, name, priority);
    } catch (err) {
      if (!(err instanceof CfApiError && err.kind === "conflict")) throw err;
      found = await findTunnelByName(ctx.cf, s.accountId, name, priority);
      if (!found) throw err;
    }
  }
  const out: StepOutcome = { patch: { tunnel_id: found.id } };
  // The old token is dead with the old tunnel: yaran sees the higher token_version on W5.
  if (m.tunnel_id && m.tunnel_id !== found.id) out.patch = { ...out.patch, tunnel_secret_generation: m.tunnel_secret_generation + 1 };
  return out;
};

const ingress: StepFn = async (sc) => {
  const { ctx, s, m, priority } = sc;
  const input = desiredInput(sc.s, sc.m);
  if (!m.tunnel_id || !m.access_app_aud) throw new ProvisionError("provisioning_failed", "ingress step reached without a tunnel or Access AUD");
  const port = m.origin_port;
  const config = ingressConfig(input.hostname, port, teamNameFor(s.teamDomain), m.access_app_aud);
  const version = await putTunnelConfig(ctx.cf, s.accountId, m.tunnel_id, config, priority);
  return { patch: { ingress_version: version, ingress_origin_port: port } };
};

const dns: StepFn = async (sc) => {
  const { ctx, s, m, priority } = sc;
  const input = desiredInput(sc.s, sc.m);
  if (!m.tunnel_id) throw new ProvisionError("provisioning_failed", "DNS step reached without a tunnel");
  const desired = dnsBody(input, m.tunnel_id);
  if (m.dns_record_id) {
    const live = await orNull(() => getDnsRecord(ctx.cf, s.zoneId, m.dns_record_id as string, priority));
    if (live && live.comment === desired.comment) {
      if (dnsDrift(desired, live).length > 0) await patchDnsRecord(ctx.cf, s.zoneId, live.id, desired, priority);
      return {};
    }
  }
  const adopt = async () => {
    const records = await findDnsByName(ctx.cf, s.zoneId, input.hostname, priority);
    const foreign = records.find((r) => r.comment !== desired.comment);
    if (foreign) throw conflict(input.hostname, `a ${foreign.type} record`);
    const ours = records[0];
    if (ours && dnsDrift(desired, ours).length > 0) await patchDnsRecord(ctx.cf, s.zoneId, ours.id, desired, priority);
    return ours ?? null;
  };
  let found = sc.hadIntent ? await adopt() : null;
  if (!found) {
    await sc.markIntent();
    try {
      found = await createDnsRecord(ctx.cf, s.zoneId, desired, priority);
    } catch (err) {
      if (!(err instanceof CfApiError && err.kind === "conflict")) throw err;
      found = await adopt();
      if (!found) throw err;
    }
  }
  return { patch: { dns_record_id: found.id } };
};

const finalize: StepFn = async (sc) => {
  if (sc.op.kind === "provision") await markAwaitingClaim(sc.ctx.db, sc.m.id);
  return {};
};

export const PROVISION_STEPS: Record<ProvisionStep, StepFn> = { preflight, policy, app, tunnel, ingress, dns, finalize };
