/**
 * Teardown steps T1-T7 (D21): DNS, invalidate the tunnel secret, evict connections, delete the
 * tunnel, delete the Access app, delete the policy, release the machine row.
 *
 * DNS goes first so the hostname stops resolving before any protection is removed; the
 * Access app and its policy go last, so anything still able to reach the origin meets Access
 * at every instant. Compensation of a failed provision runs these same steps.
 *
 * - Every step treats 404 as "already done", so a teardown is idempotent and resumable.
 * - A resource whose marker is not ours is left alone (never deleted).
 * - `?cascade=true` is never used: T2 (secret invalidation) and T3 (eviction) already
 *   guarantee no live connector can reconnect.
 * - A tunnel delete refused while connections remain loops T3→T4 every 10 s, at most 5 times
 *   per drive, then backs off; after the full backoff the op fails `tunnel_delete_blocked`.
 *
 * <module-headers:begin>
 * Uses:
 * src/provisioning/steps-teardown.ts
 * ├── src/cloudflare/access.ts
 * ├── src/cloudflare/dns.ts
 * ├── src/cloudflare/errors.ts
 * ├── src/cloudflare/tunnels.ts
 * ├── src/provisioning/engine.ts
 * ├── src/provisioning/machine-rows.ts
 * ├── src/provisioning/naming.ts
 * ├── src/provisioning/ops-store.ts
 * └── src/provisioning/steps-provision.ts
 * External: none
 *
 * Used by:
 * src/provisioning/steps-teardown.ts
 * └── src/provisioning/engine.ts
 * <module-headers:end>
 */
import { deleteApp, deletePolicy, getApp, getPolicy } from "../cloudflare/access.ts";
import { deleteDnsRecord, getDnsRecord } from "../cloudflare/dns.ts";
import { CfApiError } from "../cloudflare/errors.ts";
import { deleteTunnel, deleteTunnelConnections, patchTunnelSecret, randomTunnelSecret } from "../cloudflare/tunnels.ts";
import type { StepFn } from "./engine.ts";
import { RELEASED } from "./machine-rows.ts";
import { appName, dnsComment } from "./naming.ts";
import type { TeardownStep } from "./ops-store.ts";
import { orNull } from "./steps-provision.ts";

export const TUNNEL_DELETE_LOOPS = 5;
export const TUNNEL_DELETE_WAIT_MS = 10_000;

/** Runs a delete, treating 404 as done. */
async function gone(del: () => Promise<void>): Promise<void> {
  try {
    await del();
  } catch (err) {
    if (!(err instanceof CfApiError && err.kind === "not_found")) throw err;
  }
}

const unpublishDns: StepFn = async ({ ctx, s, m, priority }) => {
  if (!m.dns_record_id) return {};
  const live = await orNull(() => getDnsRecord(ctx.cf, s.zoneId, m.dns_record_id as string, priority));
  if (live && live.comment === dnsComment(s.instanceId, m.id)) {
    await gone(() => deleteDnsRecord(ctx.cf, s.zoneId, live.id, priority));
  } else if (live) {
    ctx.log.warn("teardown.dns_not_ours", { machine_id: m.id, record_id: live.id });
  }
  return { patch: { dns_record_id: null } };
};

const invalidate: StepFn = async ({ ctx, s, m, priority }) => {
  if (!m.tunnel_id) return { next: "delete_app" };
  try {
    // Any token in the response is discarded: this rotation only kills the old one.
    await patchTunnelSecret(ctx.cf, s.accountId, m.tunnel_id, randomTunnelSecret(), priority);
  } catch (err) {
    if (err instanceof CfApiError && err.kind === "not_found") return { next: "delete_app", patch: { tunnel_id: null } };
    throw err;
  }
  return {};
};

const connections: StepFn = async ({ ctx, s, m, priority }) => {
  if (!m.tunnel_id) return { next: "delete_app" };
  await gone(() => deleteTunnelConnections(ctx.cf, s.accountId, m.tunnel_id as string, priority));
  return {};
};

const deleteTunnelStep: StepFn = async ({ ctx, s, m, priority, mem }) => {
  if (!m.tunnel_id) return {};
  try {
    await gone(() => deleteTunnel(ctx.cf, s.accountId, m.tunnel_id as string, priority));
  } catch (err) {
    // Cloudflare refuses while connections remain (UNVERIFIED code): evict again and retry.
    if (!(err instanceof CfApiError && (err.kind === "invalid" || err.kind === "conflict"))) throw err;
    if (mem.tunnelDeleteLoops >= TUNNEL_DELETE_LOOPS) {
      throw new CfApiError("transient", err.status, err.endpoint, err.cfErrors, null, "tunnel still has connections after repeated eviction");
    }
    mem.tunnelDeleteLoops++;
    await ctx.sleep(TUNNEL_DELETE_WAIT_MS);
    return { next: "connections" };
  }
  return { patch: { tunnel_id: null } };
};

const deleteAppStep: StepFn = async ({ ctx, s, m, priority }) => {
  if (!m.access_app_id) return {};
  const live = await orNull(() => getApp(ctx.cf, s.accountId, m.access_app_id as string, priority));
  if (live && live.name === appName(s.instanceId, m.id)) {
    await gone(() => deleteApp(ctx.cf, s.accountId, live.id, priority));
  } else if (live) {
    ctx.log.warn("teardown.app_not_ours", { machine_id: m.id, app_id: live.id });
  }
  return { patch: { access_app_id: null } };
};

const deletePolicyStep: StepFn = async ({ ctx, s, m, priority }) => {
  if (!m.access_policy_id) return {};
  const id = m.access_policy_id;
  try {
    await gone(() => deletePolicy(ctx.cf, s.accountId, id, priority));
  } catch (err) {
    if (!(err instanceof CfApiError && err.kind === "invalid")) throw err;
    // Still attached somewhere (UNVERIFIED error shape): retry later rather than fail outright.
    const live = await orNull(() => getPolicy(ctx.cf, s.accountId, id, priority));
    if (live && (live.app_count ?? 0) > 0) {
      throw new CfApiError("transient", err.status, err.endpoint, err.cfErrors, null, "policy still attached to an Access application");
    }
    throw err;
  }
  return { patch: { access_policy_id: null } };
};

const release: StepFn = async ({ ctx, op }) => {
  const now = ctx.now();
  if (op.state === "compensating") {
    return { patch: { ...RELEASED, status: "failed", revoke_reason: "provision_failed", revoked_at: now } };
  }
  return { patch: { ...RELEASED, status: "revoked", revoked_at: now } };
};

export const TEARDOWN_STEPS: Record<TeardownStep, StepFn> = {
  unpublish_dns: unpublishDns,
  invalidate,
  connections,
  delete_tunnel: deleteTunnelStep,
  delete_app: deleteAppStep,
  delete_policy: deletePolicyStep,
  release,
};
