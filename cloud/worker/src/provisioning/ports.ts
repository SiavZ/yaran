/**
 * Provisioning ports: the narrow seams the engine consumes from the Worker foundation (Phase 04).
 *
 * The provisioning engine, the Cloudflare client and the reconcile tasks never import 04's
 * modules directly. They take a `ProvCtx` built from these interfaces, so 04's real D1
 * binding, audit writer, logger, sanitizer and settings store plug in through one adapter,
 * and the tests plug in fakes.
 *
 * - `D1Like` is the structural subset of Cloudflare's `D1Database` the engine uses.
 * - Nothing here does I/O; `countQueries` only wraps a context to count D1 work.
 * - Audit actions are the registry names (02 `registry/audit-actions.json`); a test pins it.
 *
 * <module-headers:begin>
 * Uses:
 * src/provisioning/ports.ts
 * ├── @yaran/protocol:src/index.ts
 * └── src/cloudflare/client.ts
 * External: none
 *
 * Used by:
 * src/provisioning/ports.ts
 * ├── src/cloudflare/budget.ts
 * ├── src/provisioning/context.ts
 * ├── src/provisioning/engine.ts
 * ├── src/provisioning/index.ts
 * ├── src/provisioning/machine-rows.ts
 * ├── src/provisioning/ops-store.ts
 * ├── src/provisioning/quota.ts
 * ├── src/provisioning/settings.ts
 * ├── src/reconcile/drift.ts
 * ├── src/reconcile/kit.ts
 * ├── src/reconcile/orphans.ts
 * ├── src/reconcile/status.ts
 * ├── src/reconcile/tasks.ts
 * ├── test/provisioning/helpers/d1.ts
 * ├── test/provisioning/helpers/world.ts
 * ├── test/provisioning/registry.test.ts
 * └── test/provisioning/tasks.test.ts
 * <module-headers:end>
 */
import type { ErrorCode } from "@yaran/protocol";
import type { CfClient } from "../cloudflare/client.ts";

export interface D1Result<T = unknown> {
  results: T[];
  meta: { changes: number };
}

export interface D1Stmt {
  bind(...values: unknown[]): D1Stmt;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}

export interface D1Like {
  prepare(sql: string): D1Stmt;
  batch(statements: D1Stmt[]): Promise<D1Result[]>;
}

/** Every audit action this phase records; all exist in 02's registry (test-enforced). */
export type ProvAuditAction =
  | "provision.step"
  | "provision.done"
  | "provision.failed"
  | "teardown.step"
  | "teardown.done"
  | "teardown.failed"
  | "machine.rotated"
  | "machine.origin_changed"
  | "machine.reconciled"
  | "drift.repaired"
  | "orphan.found"
  | "orphan.deleted"
  | "quota.refused"
  | "cloudflare.rate_limited";

export interface AuditEvent {
  action: ProvAuditAction;
  target: { kind: "org" | "machine"; id: string | null };
  outcome: "ok" | "failed";
  error_code?: ErrorCode;
  detail?: Record<string, unknown>;
}

/** 04's `audit.record`, already bound to the request's actor. */
export type AuditPort = (event: AuditEvent) => Promise<void>;

export interface LoggerPort {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

/** 04's settings store: validated stored values by key, one query; absent keys are omitted. */
export interface SettingsPort {
  getMany(keys: readonly string[]): Promise<Record<string, unknown>>;
}

export type ActorKind = "user" | "admin" | "machine" | "system" | "setup";

export interface ProvCtx {
  db: D1Like;
  cf: CfClient;
  audit: AuditPort;
  log: LoggerPort;
  /** 04's `security/sanitize.ts` (twin of `sanitize.rs::for_terminal`). */
  sanitize: (text: string) => string;
  settings: SettingsPort;
  actor: { kind: ActorKind; id: string | null };
  /** Unix seconds. */
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** The Worker's `APP_CALLBACK_URLS` var, read only under G1 fallback L2. */
  appCallbackUrls: readonly string[];
}

/**
 * A context whose D1 statements, batches, settings reads and audit writes are counted, for
 * per-run caps. The budget row's one read and one write per invocation are not counted.
 */
export interface CountedCtx {
  ctx: ProvCtx;
  queries: () => number;
}

export function countQueries(ctx: ProvCtx): CountedCtx {
  let n = 0;
  // batch() must receive the real statements, so each wrapper remembers its inner one.
  const inner = new WeakMap<D1Stmt, D1Stmt>();
  const wrapStmt = (s: D1Stmt): D1Stmt => {
    const w: D1Stmt = {
      bind: (...v) => wrapStmt(s.bind(...v)),
      first: <T>() => (n++, s.first<T>()),
      all: <T>() => (n++, s.all<T>()),
      run: () => (n++, s.run()),
    };
    inner.set(w, s);
    return w;
  };
  const db: D1Like = {
    prepare: (sql) => wrapStmt(ctx.db.prepare(sql)),
    batch: (stmts) => (n++, ctx.db.batch(stmts.map((s) => inner.get(s) ?? s))),
  };
  const audit: AuditPort = (e) => (n++, ctx.audit(e));
  const settings: SettingsPort = { getMany: (keys) => (n++, ctx.settings.getMany(keys)) };
  return { ctx: { ...ctx, db, audit, settings }, queries: () => n };
}
