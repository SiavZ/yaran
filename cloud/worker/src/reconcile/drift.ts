/**
 * `cf_drift` task: compares a few live machines per run with their desired state and repairs
 * what drifted.
 *
 * A cursor walks live machines by id (`drift_machines_per_run`, default 5, 4 GETs each);
 * machines `cf_status` found without a tunnel go first. A drifted field is put back with a
 * PUT/PATCH built from `desired.ts` and audited `drift.repaired` with its reasons; a vanished
 * resource starts a `repair` op, which `drive_ops` drives. The ingress check includes the
 * origin port, which backs up the end-of-op port reconciliation.
 *
 * - Background priority; machines with a live op are skipped (the op owns them).
 * - Stops before the per-run subrequest cap; `drift_machines_per_run = 0` disables repair.
 *
 * <module-headers:begin>
 * Uses:
 * src/reconcile/drift.ts
 * ├── src/cloudflare/access.ts
 * ├── src/cloudflare/desired.ts
 * ├── src/cloudflare/dns.ts
 * ├── src/cloudflare/tunnels.ts
 * ├── src/provisioning/engine.ts
 * ├── src/provisioning/machine-rows.ts
 * ├── src/provisioning/ops-store.ts
 * ├── src/provisioning/ports.ts
 * ├── src/provisioning/settings.ts
 * ├── src/provisioning/steps-provision.ts
 * └── src/reconcile/kit.ts
 * External: none
 *
 * Used by:
 * src/reconcile/drift.ts
 * ├── src/provisioning/index.ts
 * ├── src/reconcile/status.ts
 * ├── src/reconcile/tasks.ts
 * ├── test/provisioning/drift.test.ts
 * ├── test/provisioning/origin-port.test.ts
 * └── test/provisioning/status.test.ts
 * <module-headers:end>
 */
import { getApp, getPolicy, replaceApp, replacePolicy } from "../cloudflare/access.ts";
import { appBody, appDrift, dnsBody, dnsDrift, ingressConfig, ingressDrift, policyBody, policyDrift, teamNameFor } from "../cloudflare/desired.ts";
import { getDnsRecord, patchDnsRecord } from "../cloudflare/dns.ts";
import { getTunnelConfig, putTunnelConfig } from "../cloudflare/tunnels.ts";
import { REPAIR_PLAN } from "../provisioning/engine.ts";
import { MACHINE_SELECT, machinePatch, type MachinePatch, type MachineRow } from "../provisioning/machine-rows.ts";
import { liveOpFor, startOp } from "../provisioning/ops-store.ts";
import type { D1Stmt, ProvCtx } from "../provisioning/ports.ts";
import { loadProvSettings, type ProvSettings } from "../provisioning/settings.ts";
import { appOptions, desiredInput, orNull } from "../provisioning/steps-provision.ts";
import { DEFAULT_TASK_LIMITS, readTaskCursor, writeTaskCursorStmts, yieldingToBudget, type TaskLimits, type TaskOutcome } from "./kit.ts";

export const DRIFT_TASK = "cf_drift";
/** Worst case per machine: 4 GETs plus 4 repairs. */
const CALLS_PER_MACHINE = 8;

interface DriftCursor {
  after: string | null;
  priority: string[];
}

/** Restarts the walk from the first machine (W28, or 07 after a settings change). */
export function resetDriftCursorStmt(ctx: ProvCtx): D1Stmt {
  return ctx.db.prepare("UPDATE scheduled_tasks SET cursor = json_set(COALESCE(cursor, '{}'), '$.after', NULL) WHERE task = ?").bind(DRIFT_TASK);
}

/** Statements that put `ids` at the front of the next drift run. */
export async function pullDriftForwardStmts(ctx: ProvCtx, ids: string[]): Promise<D1Stmt[]> {
  const c = await readTaskCursor<DriftCursor>(ctx, DRIFT_TASK);
  const priority = [...new Set([...ids, ...(c.priority ?? [])])].slice(0, 100);
  return writeTaskCursorStmts(ctx, DRIFT_TASK, { after: c.after ?? null, priority });
}

const LIVE = "m.status IN ('awaiting_claim','active')";

export function runCfDrift(ctx: ProvCtx, limits: TaskLimits = DEFAULT_TASK_LIMITS): Promise<TaskOutcome> {
  return yieldingToBudget(DRIFT_TASK, ctx, async () => {
    const s = await loadProvSettings(ctx);
    ctx.cf.budget.backgroundReserve = s.apiBackgroundReserve;
    const n = s.driftMachinesPerRun;
    if (n === 0) return { ok: true, note: "drift repair is disabled (drift_machines_per_run = 0)" };
    const c = await readTaskCursor<DriftCursor>(ctx, DRIFT_TASK);
    const priority = c.priority ?? [];
    const first = priority.slice(0, n);
    const prio = first.length
      ? (await ctx.db.prepare(`${MACHINE_SELECT} WHERE ${LIVE} AND m.id IN (${first.map(() => "?").join(",")})`).bind(...first).all<MachineRow>()).results
      : [];
    const rest = n - prio.length;
    const walk = rest > 0
      ? (await ctx.db.prepare(`${MACHINE_SELECT} WHERE ${LIVE} AND m.id > ? ORDER BY m.id LIMIT ?`).bind(c.after ?? "", rest).all<MachineRow>()).results
      : [];
    const startCalls = ctx.cf.calls;
    let repaired = 0;
    let checked = 0;
    let after = c.after ?? null;
    for (const m of [...prio, ...walk]) {
      if (ctx.cf.calls - startCalls + CALLS_PER_MACHINE > limits.subrequests) break;
      if (!(await liveOpFor(ctx.db, m.id))) repaired += (await checkMachine(ctx, s, m)) ? 1 : 0;
      checked++;
      if (walk.includes(m)) after = m.id;
    }
    // A short walk reached the end: the next run starts again from the first machine.
    if (checked === prio.length + walk.length && walk.length < rest) after = null;
    // Priority ids leave the queue once checked, or when they are no longer live machines.
    const done = new Set(prio.slice(0, checked).map((m) => m.id));
    const live = new Set(prio.map((m) => m.id));
    const left = priority.filter((id) => !(first.includes(id) && (done.has(id) || !live.has(id))));
    await ctx.db.batch(writeTaskCursorStmts(ctx, DRIFT_TASK, { after, priority: left }));
    return { ok: true, note: `checked ${checked} machines, repaired drift on ${repaired}` };
  });
}

/** Checks one machine; returns whether anything was repaired or a repair op started. */
export async function checkMachine(ctx: ProvCtx, s: ProvSettings, m: MachineRow): Promise<boolean> {
  const p = "background" as const;
  const reasons: string[] = [];
  const patch: MachinePatch = {};
  let missing = !m.hostname || !m.access_policy_id || !m.access_app_id || !m.tunnel_id || !m.dns_record_id;
  if (!missing) {
    const input = desiredInput(s, m);
    const policy = await orNull(() => getPolicy(ctx.cf, s.accountId, m.access_policy_id as string, p));
    if (!policy) missing = true;
    else {
      const want = policyBody(input);
      const r = policyDrift(want, policy);
      if (r.length) await replacePolicy(ctx.cf, s.accountId, policy.id, want, p);
      reasons.push(...r);
    }
    const app = await orNull(() => getApp(ctx.cf, s.accountId, m.access_app_id as string, p));
    let aud = m.access_app_aud;
    if (!app) missing = true;
    else {
      const want = appBody(input, m.access_policy_id as string, appOptions(s, ctx.appCallbackUrls));
      const r = appDrift(want, app);
      if (r.length) await replaceApp(ctx.cf, s.accountId, app.id, want, p);
      reasons.push(...r);
      if (app.aud !== m.access_app_aud) {
        patch.access_app_aud = app.aud;
        aud = app.aud;
      }
    }
    const config = await orNull(() => getTunnelConfig(ctx.cf, s.accountId, m.tunnel_id as string, p));
    if (!config) missing = true;
    else if (aud) {
      const want = ingressConfig(input.hostname, m.origin_port, teamNameFor(s.teamDomain), aud);
      const r = ingressDrift(want, config);
      if (m.ingress_origin_port !== m.origin_port) r.push("ingress.origin_port");
      if (r.length) {
        patch.ingress_version = await putTunnelConfig(ctx.cf, s.accountId, m.tunnel_id as string, want, p);
        patch.ingress_origin_port = m.origin_port;
      }
      reasons.push(...r);
    }
    const record = await orNull(() => getDnsRecord(ctx.cf, s.zoneId, m.dns_record_id as string, p));
    if (!record) missing = true;
    else {
      const want = dnsBody(input, m.tunnel_id as string);
      const r = dnsDrift(want, record);
      if (r.length) await patchDnsRecord(ctx.cf, s.zoneId, record.id, want, p);
      reasons.push(...r);
    }
  }
  const stmt = machinePatch(ctx.db, m.id, patch);
  if (stmt) await stmt.run();
  if (missing) await startOp(ctx.db, { machineId: m.id, kind: "repair", params: { plan: REPAIR_PLAN, intent: {} }, requestedBy: "system", now: ctx.now() });
  if (reasons.length || missing) {
    await ctx.audit({ action: "drift.repaired", target: { kind: "machine", id: m.id }, outcome: "ok", detail: { reasons, repair_op_started: missing } });
  }
  return reasons.length > 0 || missing;
}
