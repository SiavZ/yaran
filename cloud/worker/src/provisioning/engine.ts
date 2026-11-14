/**
 * The saga engine: `driveOp` runs one op's steps under a D1 lease until it finishes, defers,
 * or spends its drive budget.
 *
 * Three drivers call it (the request that started the op, the waiting page's poll, and the
 * `drive_ops` cron task); the lease makes them safe to race. Errors follow one policy:
 * `transient` and `rate_limited` back off and retry, everything else is permanent, and a
 * permanent failure of a `provision` op switches the same op into compensation, which runs
 * the teardown steps over whatever ids were recorded.
 *
 * - Create-intents (`params.intent.<step>`) are written before every POST, so a crash after
 *   a successful POST is adopted by marker on the next drive instead of duplicated.
 * - A D1 error is not caught: it is a crash, and the lease expiring is the recovery.
 * - Every state change is audited with the sanitized error; tokens never reach `params`.
 * - When an op ends, `followUps` starts the teardown a superseded op left behind, or a
 *   P4-only repair when `origin_port` moved while the op ran (§7).
 *
 * <module-headers:begin>
 * Uses:
 * src/provisioning/engine.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/cloudflare/budget.ts
 * ├── src/cloudflare/errors.ts
 * ├── src/provisioning/machine-rows.ts
 * ├── src/provisioning/ops-store.ts
 * ├── src/provisioning/ports.ts
 * ├── src/provisioning/provision-error.ts
 * ├── src/provisioning/settings.ts
 * ├── src/provisioning/steps-provision.ts
 * ├── src/provisioning/steps-rotate.ts
 * └── src/provisioning/steps-teardown.ts
 * External: none
 *
 * Used by:
 * src/provisioning/engine.ts
 * ├── src/provisioning/index.ts
 * ├── src/provisioning/steps-provision.ts
 * ├── src/provisioning/steps-rotate.ts
 * ├── src/provisioning/steps-teardown.ts
 * ├── src/reconcile/drift.ts
 * ├── src/reconcile/tasks.ts
 * ├── test/provisioning/crash-matrix.test.ts
 * ├── test/provisioning/ops-store.test.ts
 * ├── test/provisioning/origin-port.test.ts
 * └── test/provisioning/teardown.test.ts
 * <module-headers:end>
 */
import type { ErrorCode } from "@yaran/protocol";
import type { Priority } from "../cloudflare/budget.ts";
import { CfApiError, isRetryable, safeErrorDetail, wireCodeFor } from "../cloudflare/errors.ts";
import { LIVE_STATUSES, loadMachine, machinePatch, type MachinePatch, type MachineRow } from "./machine-rows.ts";
import {
  acquireLease,
  backoffSeconds,
  deferStmt,
  finishStmt,
  liveOpFor,
  loadOp,
  recordStepStmt,
  startOp,
  type OpKind,
  type OpParams,
  type OpRow,
  type StepName,
} from "./ops-store.ts";
import { countQueries, type ProvAuditAction, type ProvCtx } from "./ports.ts";
import { ProvisionError } from "./provision-error.ts";
import { loadProvSettings, type ProvSettings } from "./settings.ts";
import { PROVISION_STEPS } from "./steps-provision.ts";
import { ROTATE_STEPS } from "./steps-rotate.ts";
import { TEARDOWN_STEPS } from "./steps-teardown.ts";

export const PROVISION_PLAN: StepName[] = ["preflight", "policy", "app", "tunnel", "ingress", "dns", "finalize"];
export const REPAIR_PLAN: StepName[] = ["policy", "app", "tunnel", "ingress", "dns"];
export const PORT_REPAIR_PLAN: StepName[] = ["ingress"];
export const TEARDOWN_PLAN: StepName[] = ["unpublish_dns", "invalidate", "connections", "delete_tunnel", "delete_app", "delete_policy", "release"];
export const ROTATE_PLAN: StepName[] = ["rotate_secret", "evict"];

export interface DriveBudget {
  wallMs: number;
  apiCalls: number;
  /** D1 statements, batches and audit writes; the cron path sets it (Free plan: 50 per run). */
  queries?: number;
}

/** Inline drive from the request that started the op (06 authorize confirm, 07 admin action). */
export const INLINE_BUDGET: DriveBudget = { wallMs: 15_000, apiCalls: 20 };

/** Per-drive memory that must never be persisted (the rotated token) or outlive the drive. */
export interface DriveMemory {
  token: string | null;
  tunnelDeleteLoops: number;
}

export interface StepCtx {
  ctx: ProvCtx;
  s: ProvSettings;
  m: MachineRow;
  op: OpRow;
  priority: Priority;
  /** An intent for this step existed when the step started: run the adopt lookup first. */
  hadIntent: boolean;
  /** Records the create-intent for this step (one batch that also renews the lease). */
  markIntent: () => Promise<void>;
  mem: DriveMemory;
}

export interface StepOutcome {
  patch?: MachinePatch;
  params?: Partial<OpParams>;
  /** Overrides the next step in the plan (skips, or the T3→T4 loop). */
  next?: StepName | "done";
}

export type StepFn = (sc: StepCtx) => Promise<StepOutcome>;

const STEPS: Record<StepName, StepFn> = { ...PROVISION_STEPS, ...TEARDOWN_STEPS, ...ROTATE_STEPS };

export interface DriveResult {
  op: OpRow;
  /** The token a rotate step obtained in this drive; returned to the inline caller only. */
  token: string | null;
}

class LeaseLost extends Error {}

const nextInPlan = (plan: StepName[], step: StepName): StepName | "done" => plan[plan.indexOf(step) + 1] ?? "done";

function stepAction(op: OpRow): ProvAuditAction | null {
  if (op.state === "compensating" || op.kind === "teardown") return "teardown.step";
  return op.kind === "rotate" ? null : "provision.step";
}

function failAction(kind: OpKind): ProvAuditAction {
  switch (kind) {
    case "provision":
    case "repair":
      return "provision.failed";
    case "teardown":
      return "teardown.failed";
    case "rotate":
      return "machine.rotated";
  }
}

export async function driveOp(base: ProvCtx, opId: string, budget: DriveBudget, priority: Priority = "interactive"): Promise<DriveResult> {
  const counted = countQueries(base);
  const ctx = counted.ctx;
  const db = ctx.db;
  const owner = crypto.randomUUID();
  const startMs = Date.now();
  const startCalls = ctx.cf.calls;
  const mem: DriveMemory = { token: null, tunnelDeleteLoops: 0 };
  if (!(await acquireLease(db, opId, owner, ctx.now()))) {
    return { op: (await loadOp(db, opId)) as OpRow, token: null };
  }
  const s = await loadProvSettings(ctx);
  ctx.cf.budget.backgroundReserve = s.apiBackgroundReserve;
  let op = (await loadOp(db, opId)) as OpRow;
  let machineId = op.machine_id;
  const spent = () =>
    Date.now() - startMs >= budget.wallMs ||
    ctx.cf.calls - startCalls >= budget.apiCalls ||
    (budget.queries !== undefined && counted.queries() + 6 > budget.queries);

  try {
    for (;;) {
      const now = ctx.now();
      const m = await loadMachine(db, op.machine_id);
      if (!m) {
        await finishStmt(db, opId, owner, "failed", "internal", "machine row missing", now).run();
        break;
      }
      machineId = m.id;
      if (m.status === "revoking" && op.kind !== "teardown" && op.state !== "compensating") {
        await finishStmt(db, opId, owner, "failed", null, "superseded by a teardown of this machine", now).run();
        break;
      }
      if (op.step === "done") {
        await complete(ctx, op, owner);
        break;
      }
      if (spent()) {
        const state = op.state === "compensating" ? "compensating" : "pending";
        await deferStmt(db, opId, owner, { state, attempt: op.attempt, nextAttemptAt: now, errorCode: op.last_error_code, error: op.last_error }, now).run();
        break;
      }
      const step = op.step;
      const hadIntent = op.params.intent[step] !== undefined;
      const sc: StepCtx = {
        ctx,
        s,
        m,
        op,
        priority,
        hadIntent,
        mem,
        markIntent: async () => {
          op = { ...op, params: { ...op.params, intent: { ...op.params.intent, [step]: op.attempt } } };
          const r = await recordStepStmt(db, opId, owner, { step, params: op.params }, ctx.now()).run();
          if (r.meta.changes !== 1) throw new LeaseLost();
        },
      };
      let out;
      try {
        out = await STEPS[step](sc);
      } catch (err) {
        const res = await onError(ctx, s, op, owner, err);
        if (res === "stop") break;
        op = res;
        continue;
      }
      const next = out.next ?? nextInPlan(op.params.plan, step);
      const params: OpParams = { ...op.params, ...out.params };
      const stmts = [recordStepStmt(db, opId, owner, { step: next, params }, ctx.now())];
      const mp = machinePatch(db, m.id, out.patch ?? {});
      if (mp) stmts.push(mp);
      const [r] = await db.batch(stmts);
      if (r?.meta.changes !== 1) throw new LeaseLost();
      const action = stepAction(op);
      if (action) await ctx.audit({ action, target: { kind: "machine", id: m.id }, outcome: "ok", detail: { op_id: opId, kind: op.kind, step } });
      op = { ...op, step: next, params };
    }
  } catch (err) {
    if (!(err instanceof LeaseLost)) throw err;
    ctx.log.warn("provisioning.lease_lost", { op_id: opId });
  }
  const final = (await loadOp(db, opId)) as OpRow;
  if (final.state === "succeeded" || final.state === "failed" || final.state === "compensated") await followUps(ctx, machineId, final.kind);
  return { op: final, token: mem.token };
}

async function complete(ctx: ProvCtx, op: OpRow, owner: string): Promise<void> {
  const now = ctx.now();
  const target = { kind: "machine" as const, id: op.machine_id };
  if (op.state === "compensating") {
    await finishStmt(ctx.db, op.id, owner, "compensated", op.params.compensate_code ?? "provisioning_failed", op.last_error, now).run();
    await ctx.audit({ action: "teardown.done", target, outcome: "ok", detail: { op_id: op.id, compensation: true } });
    return;
  }
  await finishStmt(ctx.db, op.id, owner, "succeeded", null, null, now).run();
  const done: Record<OpKind, ProvAuditAction> = {
    provision: "provision.done",
    repair: "provision.done",
    teardown: "teardown.done",
    rotate: "machine.rotated",
  };
  await ctx.audit({ action: done[op.kind], target, outcome: "ok", detail: { op_id: op.id, kind: op.kind } });
}

/** Applies the error policy; returns "stop" or the op switched into compensation. */
async function onError(ctx: ProvCtx, s: ProvSettings, op: OpRow, owner: string, err: unknown): Promise<"stop" | OpRow> {
  let code: ErrorCode;
  let detail: Record<string, unknown>;
  let retryable = false;
  let retryAfter = 0;
  if (err instanceof CfApiError) {
    retryable = isRetryable(err);
    code = wireCodeFor(err.kind);
    detail = safeErrorDetail(err, ctx.sanitize);
    retryAfter = err.retryAfter ?? 0;
  } else if (err instanceof ProvisionError) {
    code = err.code;
    detail = { message: ctx.sanitize(err.message), ...err.details };
  } else {
    throw err;
  }
  const now = ctx.now();
  const db = ctx.db;
  const target = { kind: "machine" as const, id: op.machine_id };
  const attempt = op.attempt + 1;
  const errorText = JSON.stringify({ step: op.step, ...detail });
  if (retryable && attempt < s.provisionMaxAttempts) {
    const state = op.state === "compensating" ? "compensating" : "pending";
    const nextAttemptAt = now + Math.max(backoffSeconds(attempt), retryAfter);
    await deferStmt(db, op.id, owner, { state, attempt, nextAttemptAt, errorCode: code, error: errorText }, now).run();
    const rateLimited = err instanceof CfApiError && err.kind === "rate_limited";
    const action = rateLimited ? "cloudflare.rate_limited" : (stepAction(op) ?? failAction(op.kind));
    await ctx.audit({ action, target, outcome: "failed", error_code: code, detail: { op_id: op.id, step: op.step, attempt, retry_at: nextAttemptAt, ...detail } });
    return "stop";
  }
  if (retryable && op.step === "delete_tunnel") code = "tunnel_delete_blocked";
  if (op.kind === "provision" && op.state !== "compensating") {
    const params: OpParams = { ...op.params, plan: TEARDOWN_PLAN, compensate_code: code };
    const step = TEARDOWN_PLAN[0] as StepName;
    const r = await recordStepStmt(db, op.id, owner, { step, params, compensate: { errorCode: code, error: errorText } }, now).run();
    if (r.meta.changes !== 1) throw new LeaseLost();
    await ctx.audit({ action: "provision.failed", target, outcome: "failed", error_code: code, detail: { op_id: op.id, step: op.step, ...detail } });
    return { ...op, state: "compensating", step, params, attempt: 0, last_error_code: code, last_error: errorText };
  }
  await finishStmt(db, op.id, owner, "failed", code, errorText, now).run();
  await ctx.audit({ action: failAction(op.kind), target, outcome: "failed", error_code: code, detail: { op_id: op.id, step: op.step, ...detail } });
  return "stop";
}

/**
 * After an op ends: a machine left `revoking` by a superseded op gets its teardown, and a live
 * machine whose ingress targets a stale port gets a P4-only repair (a port change that landed
 * mid-op). A failed teardown is not restarted here: the admin retries it (07).
 */
export async function followUps(ctx: ProvCtx, machineId: string, finishedKind: OpKind): Promise<OpRow | null> {
  const m = await loadMachine(ctx.db, machineId);
  if (!m || (await liveOpFor(ctx.db, machineId))) return null;
  const base = { machineId, requestedBy: "system", now: ctx.now() };
  if (m.status === "revoking") {
    if (finishedKind === "teardown") return null;
    return (await startOp(ctx.db, { ...base, kind: "teardown", params: { plan: TEARDOWN_PLAN, intent: {} } })).op;
  }
  if (LIVE_STATUSES.includes(m.status) && m.tunnel_id && m.access_app_aud && m.origin_port !== m.ingress_origin_port) {
    return (await startOp(ctx.db, { ...base, kind: "repair", params: { plan: PORT_REPAIR_PLAN, intent: {} } })).op;
  }
  return null;
}
