/**
 * Saga state in `provisioning_ops`: op insert, lease, batched step records and finishing.
 *
 * At most one live op per machine (partial unique index `provisioning_ops_one_live`); a D1
 * lease serializes drivers, and every step record renews that lease in the same `batch()`
 * that stores the step's result, so the recorded resource id, the step advance and the
 * lease are one transaction.
 *
 * - Uses `INSERT OR IGNORE`, conditional `UPDATE` and `meta.changes` only (D1's SQLite
 *   version is undocumented, so no `RETURNING` or upserts).
 * - `params` holds the plan, create-intents and flags: never a token or other secret.
 * - `last_error` is sanitized by the caller and capped at 1,024 characters here.
 *
 * <module-headers:begin>
 * Uses:
 * src/provisioning/ops-store.ts
 * ├── src/provisioning/machine-rows.ts
 * └── src/provisioning/ports.ts
 * External: none
 *
 * Used by:
 * src/provisioning/ops-store.ts
 * ├── src/admin/pairing-service.ts
 * ├── src/provisioning/engine.ts
 * ├── src/provisioning/index.ts
 * ├── src/provisioning/steps-provision.ts
 * ├── src/provisioning/steps-rotate.ts
 * ├── src/provisioning/steps-teardown.ts
 * ├── src/reconcile/drift.ts
 * ├── src/reconcile/tasks.ts
 * ├── test/provisioning/crash-matrix.test.ts
 * ├── test/provisioning/ops-store.test.ts
 * └── test/provisioning/teardown.test.ts
 * <module-headers:end>
 */
import type { D1Like, D1Stmt } from "./ports.ts";
import type { RevokeReason } from "./machine-rows.ts";

export const LEASE_SECONDS = 60;

export type OpKind = "provision" | "teardown" | "rotate" | "repair";
export type OpState = "pending" | "running" | "succeeded" | "failed" | "compensating" | "compensated";

export type ProvisionStep = "preflight" | "policy" | "app" | "tunnel" | "ingress" | "dns" | "finalize";
export type TeardownStep = "unpublish_dns" | "invalidate" | "connections" | "delete_tunnel" | "delete_app" | "delete_policy" | "release";
export type RotateStep = "rotate_secret" | "evict";
export type StepName = ProvisionStep | TeardownStep | RotateStep;

export const LIVE_OP_STATES: readonly OpState[] = ["pending", "running", "compensating"];

export interface OpParams {
  /** The steps this op runs, in order; compensation switches it to the teardown plan. */
  plan: StepName[];
  /** `params.intent.<step> = attempt`, written before any POST (adopt-on-resume). */
  intent: Partial<Record<StepName, number>>;
  reason?: RevokeReason;
  evict?: boolean;
  /** The 02 code compensation surfaces once it completes. */
  compensate_code?: string;
}

export interface OpRow {
  id: string;
  machine_id: string;
  kind: OpKind;
  state: OpState;
  step: StepName | "done";
  attempt: number;
  params: OpParams;
  lease_owner: string | null;
  lease_until: number | null;
  next_attempt_at: number;
  last_error_code: string | null;
  last_error: string | null;
  requested_by: string;
  created_at: number;
  updated_at: number;
}

type RawOp = Omit<OpRow, "params"> & { params: string | null };

const parse = (r: RawOp | null): OpRow | null =>
  r && { ...r, params: (r.params ? JSON.parse(r.params) : { plan: [], intent: {} }) as OpParams };

export interface NewOp {
  machineId: string;
  kind: OpKind;
  params: OpParams;
  requestedBy: string;
  now: number;
}

/**
 * The INSERT for a new op. `onlyIfRevoking` makes it conditional on the machine already being
 * `revoking`, for teardown's single batch with the status transition.
 */
export function insertOpStmt(db: D1Like, id: string, o: NewOp, onlyIfRevoking = false): D1Stmt {
  const first = o.params.plan[0] ?? "done";
  const cols = "(id, machine_id, kind, state, step, attempt, params, next_attempt_at, requested_by, created_at, updated_at)";
  const vals = [id, o.machineId, o.kind, first, JSON.stringify(o.params), o.now, o.requestedBy, o.now, o.now];
  if (!onlyIfRevoking) {
    return db.prepare(`INSERT OR IGNORE INTO provisioning_ops ${cols} VALUES (?, ?, ?, 'pending', ?, 0, ?, ?, ?, ?, ?)`).bind(...vals);
  }
  return db
    .prepare(
      `INSERT OR IGNORE INTO provisioning_ops ${cols} SELECT ?, ?, ?, 'pending', ?, 0, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM machines WHERE id = ? AND status = 'revoking')`,
    )
    .bind(...vals, o.machineId);
}

export async function loadOp(db: D1Like, id: string): Promise<OpRow | null> {
  return parse(await db.prepare("SELECT * FROM provisioning_ops WHERE id = ?").bind(id).first<RawOp>());
}

export async function liveOpFor(db: D1Like, machineId: string): Promise<OpRow | null> {
  return parse(
    await db
      .prepare("SELECT * FROM provisioning_ops WHERE machine_id = ? AND state IN ('pending','running','compensating')")
      .bind(machineId)
      .first<RawOp>(),
  );
}

export interface StartResult {
  op: OpRow;
  created: boolean;
}

/** Starts an op, or returns the machine's existing live op ("already in progress"). */
export async function startOp(db: D1Like, o: NewOp): Promise<StartResult> {
  const id = crypto.randomUUID();
  const r = await insertOpStmt(db, id, o).run();
  if (r.meta.changes === 1) return { op: (await loadOp(db, id)) as OpRow, created: true };
  const live = await liveOpFor(db, o.machineId);
  if (!live) throw new Error(`op for machine ${o.machineId} was neither inserted nor live`);
  return { op: live, created: false };
}

/** Exactly one driver wins (`changes = 1`); a compensating op stays compensating. */
export async function acquireLease(db: D1Like, opId: string, owner: string, now: number): Promise<boolean> {
  const r = await db
    .prepare(
      `UPDATE provisioning_ops SET lease_owner = ?, lease_until = ?, updated_at = ?,
         state = CASE WHEN state = 'compensating' THEN 'compensating' ELSE 'running' END
       WHERE id = ? AND state IN ('pending','running','compensating') AND (lease_until IS NULL OR lease_until < ?)`,
    )
    .bind(owner, now + LEASE_SECONDS, now, opId, now)
    .run();
  return r.meta.changes === 1;
}

export interface StepRecord {
  step: StepName | "done";
  params: OpParams;
  /** Set only when switching to compensation (with a reset attempt count and the error). */
  compensate?: { errorCode: string; error: string };
}

/** The op half of a step record: advances the step and renews the lease, only while we hold it. */
export function recordStepStmt(db: D1Like, opId: string, owner: string, rec: StepRecord, now: number): D1Stmt {
  const c = rec.compensate;
  return db
    .prepare(
      `UPDATE provisioning_ops SET step = ?, params = ?, lease_until = ?, updated_at = ?,
         state = CASE WHEN ? THEN 'compensating' ELSE state END,
         attempt = CASE WHEN ? THEN 0 ELSE attempt END,
         last_error_code = CASE WHEN ? THEN ? ELSE last_error_code END,
         last_error = CASE WHEN ? THEN ? ELSE last_error END
       WHERE id = ? AND lease_owner = ?`,
    )
    .bind(
      rec.step,
      JSON.stringify(rec.params),
      now + LEASE_SECONDS,
      now,
      c ? 1 : 0,
      c ? 1 : 0,
      c ? 1 : 0,
      c?.errorCode ?? null,
      c ? 1 : 0,
      c?.error.slice(0, 1024) ?? null,
      opId,
      owner,
    );
}

export interface Defer {
  state: "pending" | "compensating";
  attempt: number;
  nextAttemptAt: number;
  errorCode: string | null;
  error: string | null;
}

/** Releases the lease and reschedules the op (retry backoff or a spent drive budget). */
export function deferStmt(db: D1Like, opId: string, owner: string, d: Defer, now: number): D1Stmt {
  return db
    .prepare(
      `UPDATE provisioning_ops SET state = ?, attempt = ?, next_attempt_at = ?, last_error_code = ?, last_error = ?,
         lease_owner = NULL, lease_until = NULL, updated_at = ?
       WHERE id = ? AND lease_owner = ?`,
    )
    .bind(d.state, d.attempt, d.nextAttemptAt, d.errorCode, d.error?.slice(0, 1024) ?? null, now, opId, owner);
}

/** Ends the op in a terminal state and releases the lease. */
export function finishStmt(
  db: D1Like,
  opId: string,
  owner: string,
  state: "succeeded" | "failed" | "compensated",
  errorCode: string | null,
  error: string | null,
  now: number,
): D1Stmt {
  return db
    .prepare(
      `UPDATE provisioning_ops SET state = ?, step = 'done', last_error_code = ?, last_error = ?, lease_owner = NULL,
         lease_until = NULL, updated_at = ?
       WHERE id = ? AND lease_owner = ?`,
    )
    .bind(state, errorCode, error?.slice(0, 1024) ?? null, now, opId, owner);
}

/** Ops whose retry time has come and whose lease is free. */
export async function dueOps(db: D1Like, now: number, limit: number): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT id FROM provisioning_ops WHERE state IN ('pending','running','compensating') AND next_attempt_at <= ?
         AND (lease_until IS NULL OR lease_until < ?) ORDER BY next_attempt_at LIMIT ?`,
    )
    .bind(now, now, limit)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

/** Backoff after the n-th failed attempt: 30 s, 2 min, 10 min, 30 min, then hourly. */
export function backoffSeconds(attempt: number): number {
  const schedule = [30, 120, 600, 1800];
  return schedule[attempt - 1] ?? 3600;
}
