/**
 * The provisioning facade for Phase 06 (pairing, machine API) and Phase 07 (admin console).
 *
 * Starting, driving and reading ops, rotating and fetching tunnel tokens, changing the
 * origin port, and requesting a reconcile all go through here; nothing outside this
 * directory touches `provisioning_ops` or the Cloudflare columns of `machines`.
 *
 * - Tokens are returned as 02 `TunnelCredentials` and never stored.
 * - Teardown's status transition and op insert are one D1 batch; signed machine calls get
 *   `410 machine_revoked` from that moment (04 §5).
 * - The API budget observation is flushed once at the end of every facade call.
 *
 * <module-headers:begin>
 * Uses:
 * src/provisioning/index.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/cloudflare/tunnels.ts
 * ├── src/provisioning/engine.ts
 * ├── src/provisioning/machine-rows.ts
 * ├── src/provisioning/naming.ts
 * ├── src/provisioning/ops-store.ts
 * ├── src/provisioning/ports.ts
 * ├── src/provisioning/provision-error.ts
 * ├── src/provisioning/quota.ts
 * ├── src/provisioning/settings.ts
 * ├── src/reconcile/drift.ts
 * └── src/reconcile/status.ts
 * External: none
 *
 * Used by:
 * src/provisioning/index.ts
 * ├── src/admin/pairing-service.ts
 * ├── src/routes/phase06-context.ts
 * ├── src/routes/phase07-context.ts
 * ├── test/provisioning/crash-matrix.test.ts
 * ├── test/provisioning/drift.test.ts
 * ├── test/provisioning/origin-port.test.ts
 * ├── test/provisioning/orphans.test.ts
 * ├── test/provisioning/provision.test.ts
 * ├── test/provisioning/rotate.test.ts
 * ├── test/provisioning/status.test.ts
 * ├── test/provisioning/tasks.test.ts
 * └── test/provisioning/teardown.test.ts
 * <module-headers:end>
 */
import type { ErrorCode, TunnelCredentials } from "@yaran/protocol";
import { getTunnel, getTunnelToken } from "../cloudflare/tunnels.ts";
import { DRIFT_TASK, resetDriftCursorStmt } from "../reconcile/drift.ts";
import { ORPHANS_TASK } from "./quota.ts";
import { STATUS_TASK } from "../reconcile/status.ts";
import {
  driveOp,
  INLINE_BUDGET,
  PORT_REPAIR_PLAN,
  PROVISION_PLAN,
  REPAIR_PLAN,
  ROTATE_PLAN,
  TEARDOWN_PLAN,
  type DriveBudget,
} from "./engine.ts";
import { LIVE_STATUSES, loadMachine, markRevokingStmt, type MachineRow, type RevokeReason } from "./machine-rows.ts";
import { insertOpStmt, liveOpFor, loadOp, startOp, type OpKind, type OpRow, type OpState, type StepName } from "./ops-store.ts";
import type { ProvCtx } from "./ports.ts";
import { ProvisionError } from "./provision-error.ts";
import { loadProvSettings } from "./settings.ts";

export { deriveHostname, deriveUserSlug, deriveMachineSlug, userSlugCandidate } from "./naming.ts";
export { quotaWarnings, type QuotaObservation } from "./quota.ts";
export { ProvisionError } from "./provision-error.ts";
export { PROV_INTERNAL_SETTINGS } from "./settings.ts";

/** 02 `AdminMachine.provisioning.state`. */
export type WireProvisioningState = "complete" | "in_progress" | "failed" | "compensating";

export interface OpView {
  op_id: string;
  machine_id: string;
  kind: OpKind;
  step: StepName | "done";
  state: WireProvisioningState;
  error_code: string | null;
  /** The recorded failure's sanitized detail (for example a quota refusal's resource, used and limit). */
  error_detail: Record<string, unknown> | null;
}

export type OpRef = OpView & { created: boolean };

export interface StatusView {
  cf_status: string | null;
  cf_status_at: number | null;
  conns_active_at: string | null;
  conns_inactive_at: string | null;
}

export function wireState(state: OpState): WireProvisioningState {
  switch (state) {
    case "succeeded":
      return "complete";
    case "pending":
    case "running":
      return "in_progress";
    case "failed":
    case "compensated":
      return "failed";
    case "compensating":
      return "compensating";
  }
}

const view = (op: OpRow): OpView => ({
  op_id: op.id,
  machine_id: op.machine_id,
  kind: op.kind,
  step: op.step,
  state: wireState(op.state),
  error_code: op.last_error_code,
  error_detail: errorDetail(op.last_error),
});

function errorDetail(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const v: unknown = JSON.parse(text);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function flushing<T>(ctx: ProvCtx, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } finally {
    await ctx.cf.budget.flush();
  }
}

const requester = (ctx: ProvCtx) => ctx.actor.id ?? ctx.actor.kind;

async function startAndDrive(ctx: ProvCtx, machineId: string, kind: OpKind, plan: StepName[], budget: DriveBudget): Promise<OpRef> {
  const { op, created } = await startOp(ctx.db, { machineId, kind, params: { plan, intent: {} }, requestedBy: requester(ctx), now: ctx.now() });
  const res = await driveOp(ctx, op.id, budget, "interactive");
  return { ...view(res.op), created };
}

async function requireMachine(ctx: ProvCtx, machineId: string): Promise<MachineRow> {
  const m = await loadMachine(ctx.db, machineId);
  if (!m) throw new ProvisionError("not_found", `machine ${machineId} does not exist`);
  return m;
}

/** 06 at authorize confirm: provisions a `provisioning` machine (idempotent). */
export function startProvision(ctx: ProvCtx, machineId: string): Promise<OpRef> {
  return flushing(ctx, async () => {
    const m = await requireMachine(ctx, machineId);
    if (m.status !== "provisioning") throw new ProvisionError("conflict", `machine ${machineId} is ${m.status}, not provisioning`);
    return startAndDrive(ctx, machineId, "provision", PROVISION_PLAN, INLINE_BUDGET);
  });
}

/** 07 admin "repair": re-runs P1-P5 against a live machine without changing its status. */
export function startRepair(ctx: ProvCtx, machineId: string): Promise<OpRef> {
  return flushing(ctx, async () => {
    const m = await requireMachine(ctx, machineId);
    if (!LIVE_STATUSES.includes(m.status)) throw new ProvisionError("conflict", `machine ${machineId} is ${m.status}; only live machines can be repaired`);
    return startAndDrive(ctx, machineId, "repair", REPAIR_PLAN, INLINE_BUDGET);
  });
}

/**
 * W8, W11 (06); W18/W19, W21, stale (07). Moves the machine to `revoking` and inserts the
 * teardown op in one batch, then drives it inline. A live non-teardown op is superseded: the
 * engine stops it at its next step and starts the teardown when it ends.
 */
export function startTeardown(ctx: ProvCtx, machineId: string, reason: RevokeReason): Promise<OpRef> {
  return flushing(ctx, async () => {
    const m = await requireMachine(ctx, machineId);
    const now = ctx.now();
    const id = crypto.randomUUID();
    const revokedBy = ctx.actor.kind === "machine" ? "machine" : (ctx.actor.id ?? "system");
    const params = { plan: TEARDOWN_PLAN, intent: {}, reason };
    await ctx.db.batch([
      markRevokingStmt(ctx.db, machineId, reason, revokedBy),
      insertOpStmt(ctx.db, id, { machineId, kind: "teardown", params, requestedBy: requester(ctx), now }, true),
    ]);
    let live = await liveOpFor(ctx.db, machineId);
    if (!live) {
      const after = await requireMachine(ctx, machineId);
      throw new ProvisionError("conflict", `machine ${machineId} is ${after.status} (was ${m.status}); nothing to tear down`);
    }
    let created = live.id === id;
    if (live.kind !== "teardown" && live.state !== "compensating") {
      // Superseded: driving it (no API budget) stops it, and its end starts the teardown.
      // A leased op is left to its driver, whose end does the same.
      await driveOp(ctx, live.id, { wallMs: 5_000, apiCalls: 0 }, "interactive");
      live = (await liveOpFor(ctx.db, machineId)) ?? live;
      created = live.kind === "teardown";
    }
    if (live.kind !== "teardown") return { ...view(live), created: false };
    const res = await driveOp(ctx, live.id, INLINE_BUDGET, "interactive");
    return { ...view(res.op), created };
  });
}

/** W7 `user` (06) and W22 (07, `kill_connections` → `evict`). Returns the new token, never stored. */
export function rotateTunnelSecret(ctx: ProvCtx, machineId: string, opts: { evict: boolean }): Promise<TunnelCredentials> {
  return flushing(ctx, async () => {
    const m = await requireMachine(ctx, machineId);
    if (!LIVE_STATUSES.includes(m.status) || !m.tunnel_id) throw new ProvisionError("machine_not_ready", `machine ${machineId} is ${m.status}`);
    const { op, created } = await startOp(ctx.db, {
      machineId,
      kind: "rotate",
      params: { plan: ROTATE_PLAN, intent: {}, evict: opts.evict },
      requestedBy: requester(ctx),
      now: ctx.now(),
    });
    if (!created) throw new ProvisionError("provisioning_in_progress", `machine ${machineId} already has a ${op.kind} in progress; try again shortly`);
    const res = await driveOp(ctx, op.id, INLINE_BUDGET, "interactive");
    if (res.op.state !== "succeeded") {
      throw new ProvisionError((res.op.last_error_code as ErrorCode | null) ?? "provisioning_in_progress", "the tunnel secret rotation has not finished; yaran will pick up the new token on its next config check");
    }
    const after = await requireMachine(ctx, machineId);
    const token = res.token ?? (await getTunnelToken(ctx.cf, (await loadProvSettings(ctx)).accountId, after.tunnel_id as string, "interactive"));
    return { id: after.tunnel_id as string, token, token_version: after.tunnel_secret_generation };
  });
}

/** W4 claim and W7 `sync` (06, rate-limited per machine there). */
export function fetchTunnelToken(ctx: ProvCtx, machineId: string): Promise<TunnelCredentials> {
  return flushing(ctx, async () => {
    const m = await requireMachine(ctx, machineId);
    if (!LIVE_STATUSES.includes(m.status) || !m.tunnel_id) throw new ProvisionError("machine_not_ready", `machine ${machineId} is ${m.status}`);
    const s = await loadProvSettings(ctx);
    const token = await getTunnelToken(ctx.cf, s.accountId, m.tunnel_id, "interactive");
    return { id: m.tunnel_id, token, token_version: m.tunnel_secret_generation };
  });
}

/**
 * W4 (claim's authoritative `origin_port`) and W32 (`PUT /v1/machine/origin`). A change while
 * another op is live is applied by the P4-only repair that op's end starts (`followUps`).
 */
export function setOriginPort(ctx: ProvCtx, machineId: string, port: number): Promise<{ changed: boolean; op: OpRef | null }> {
  return flushing(ctx, async () => {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ProvisionError("validation_failed", "origin_port must be an integer from 1 to 65535");
    const m = await requireMachine(ctx, machineId);
    if (port === m.origin_port && port === m.ingress_origin_port) return { changed: false, op: null };
    await ctx.db.prepare("UPDATE machines SET origin_port = ? WHERE id = ?").bind(port, machineId).run();
    await ctx.audit({
      action: "machine.origin_changed",
      target: { kind: "machine", id: machineId },
      outcome: "ok",
      detail: { old_port: m.origin_port, new_port: port },
    });
    if ((await liveOpFor(ctx.db, machineId)) || !m.tunnel_id || !m.access_app_aud) return { changed: true, op: null };
    const ref = await startAndDrive(ctx, machineId, "repair", PORT_REPAIR_PLAN, { wallMs: 5_000, apiCalls: 1 });
    return { changed: true, op: ref };
  });
}

/** W28: schedules the three reconcile tasks for the next cron tick; no Cloudflare call. */
export async function requestReconcile(ctx: ProvCtx): Promise<void> {
  const now = ctx.now();
  const tasks = [STATUS_TASK, ORPHANS_TASK, DRIFT_TASK];
  await ctx.db.batch([
    ...tasks.map((t) => ctx.db.prepare("INSERT OR IGNORE INTO scheduled_tasks (task, next_run_at) VALUES (?, ?)").bind(t, now)),
    ctx.db.prepare(`UPDATE scheduled_tasks SET next_run_at = ? WHERE task IN (${tasks.map(() => "?").join(", ")})`).bind(now, ...tasks),
    resetDriftCursorStmt(ctx),
  ]);
  await ctx.audit({ action: "machine.reconciled", target: { kind: "org", id: null }, outcome: "ok", detail: { tasks } });
}

export async function getOp(ctx: ProvCtx, opId: string): Promise<OpView> {
  const op = await loadOp(ctx.db, opId);
  if (!op) throw new ProvisionError("not_found", `provisioning op ${opId} does not exist`);
  return view(op);
}

/** Drive-on-poll from the waiting page (06 rate-limits it per user). */
export function driveOpFacade(ctx: ProvCtx, opId: string, budget: DriveBudget = INLINE_BUDGET): Promise<OpView> {
  return flushing(ctx, async () => view((await driveOp(ctx, opId, budget, "interactive")).op));
}
export { driveOpFacade as driveOp };

/** One `GET cfd_tunnel/{id}` when the cache is older than 60 s, deduped by a conditional UPDATE. */
export function refreshMachineStatus(ctx: ProvCtx, machineId: string): Promise<StatusView> {
  return flushing(ctx, async () => {
    const now = ctx.now();
    const read = () =>
      ctx.db
        .prepare("SELECT cf_status, cf_status_at, conns_active_at, conns_inactive_at FROM machines WHERE id = ?")
        .bind(machineId)
        .first<StatusView>();
    const claim = await ctx.db
      .prepare("UPDATE machines SET cf_status_at = ? WHERE id = ? AND tunnel_id IS NOT NULL AND (cf_status_at IS NULL OR cf_status_at < ?)")
      .bind(now, machineId, now - 60)
      .run();
    if (claim.meta.changes !== 1) return (await read()) ?? { cf_status: null, cf_status_at: null, conns_active_at: null, conns_inactive_at: null };
    const m = await requireMachine(ctx, machineId);
    const s = await loadProvSettings(ctx);
    const t = await getTunnel(ctx.cf, s.accountId, m.tunnel_id as string, "interactive");
    await ctx.db
      .prepare("UPDATE machines SET cf_status = ?, conns_active_at = ?, conns_inactive_at = ? WHERE id = ?")
      .bind(t.deleted_at ? "unknown" : (t.status ?? "unknown"), t.conns_active_at ?? null, t.conns_inactive_at ?? null, machineId)
      .run();
    return (await read()) as StatusView;
  });
}
