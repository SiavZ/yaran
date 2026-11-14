/**
 * The audit log writer: one call, `record(ctx, …)`, appends a row to `audit_log`.
 *
 * The actor comes from the context (user, admin, machine, system for cron, setup); the
 * IP and country from the request. `detail` is scrubbed (sanitized, secrets redacted) JSON
 * capped at 2 KiB. Denied attempts are coalesced to one row per (actor, action, minute)
 * through a deterministic id and `INSERT OR IGNORE`, so a hostile client cannot spend the
 * D1 write budget. Rows are never updated; only the retention purge deletes them.
 *
 * - Use `auditStatement` to write the row in the same D1 batch as the change it records.
 * - `toAuditEntry` is the one mapping to the W25 wire shape (02 `AuditEntry`).
 *
 * <module-headers:begin>
 * Uses:
 * src/audit/audit.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/audit/actions.ts
 * ├── src/db/client.ts
 * ├── src/http/context.ts
 * └── src/log/logger.ts
 * External: none
 *
 * Used by:
 * src/audit/audit.ts
 * ├── src/auth/authorize.ts
 * ├── src/provisioning/context.ts
 * ├── src/routes/call.ts
 * ├── src/routes/phase06-context.ts
 * ├── src/scheduled/purge.ts
 * └── test/audit.test.ts
 * <module-headers:end>
 */
import { toHex, type AuditEntry, type ErrorCode } from "@yaran/protocol";
import { run, stmt } from "../db/client.ts";
import type { Actor, AppContext } from "../http/context.ts";
import { scrub } from "../log/logger.ts";
import type { AuditAction } from "./actions.ts";

export type AuditOutcome = "ok" | "denied" | "failed";
export type AuditTargetKind = AuditEntry["target"]["kind"];

export interface AuditRecord {
  action: AuditAction;
  target?: { kind: AuditTargetKind; id?: string };
  outcome: AuditOutcome;
  /** The registry code, when the outcome is not ok. */
  errorCode?: ErrorCode;
  detail?: Record<string, unknown>;
}

export const DETAIL_MAX_CHARS = 2048;

export interface AuditRow {
  id: string;
  at: number;
  actor_kind: Actor["kind"];
  actor_id: string | null;
  action: string;
  target_kind: AuditTargetKind | null;
  target_id: string | null;
  outcome: AuditOutcome;
  error_code: string | null;
  request_id: string | null;
  ip: string | null;
  country: string | null;
  detail: string | null;
}

function detailJson(detail: Record<string, unknown> | undefined): string | null {
  if (!detail) return null;
  const text = JSON.stringify(scrub(detail));
  return text.length <= DETAIL_MAX_CHARS ? text : JSON.stringify({ truncated: true });
}

/** A v4-shaped UUID derived from `seed`, so a repeated denial maps to the same row. */
async function coalescedId(seed: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed))).slice(0, 16);
  h[6] = (h[6]! & 0x0f) | 0x40;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = toHex(h);
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

/** The insert for one audit row, for batching with the change it records. */
export async function auditStatement(ctx: AppContext, rec: AuditRecord): Promise<D1PreparedStatement> {
  const actor = ctx.actor();
  const actorId = "id" in actor ? actor.id : null;
  const at = ctx.now();
  const id = rec.outcome === "denied"
    ? await coalescedId(`${actor.kind}|${actorId ?? ""}|${rec.action}|${Math.floor(at / 60)}`)
    : crypto.randomUUID();
  const country = ctx.country && /^[A-Z]{2}$/.test(ctx.country) ? ctx.country : null;
  return stmt(ctx.db,
    `INSERT OR IGNORE INTO audit_log (id, at, actor_kind, actor_id, action, target_kind, target_id, outcome, error_code, request_id, ip, country, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, at, actor.kind, actorId, rec.action, rec.target?.kind ?? null, rec.target?.id ?? null, rec.outcome,
    rec.outcome === "ok" ? null : (rec.errorCode ?? null), ctx.requestId, ctx.ip, country, detailJson(rec.detail));
}

/** Appends one audit row. */
export async function record(ctx: AppContext, rec: AuditRecord): Promise<void> {
  await (await auditStatement(ctx, rec)).run();
}

export function rfc3339(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** The W25 wire shape of a row; `email` is the actor's, when the caller joined it. */
export function toAuditEntry(row: AuditRow, email?: string): AuditEntry {
  const kind = row.actor_kind === "user" || row.actor_kind === "admin" ? "user" : row.actor_kind === "machine" ? "machine" : "system";
  const entry: AuditEntry = {
    id: row.id,
    ts: rfc3339(row.at),
    actor: { kind, ...(row.actor_id ? { id: row.actor_id } : {}), ...(email ? { email } : {}) },
    action: row.action,
    target: { kind: row.target_kind ?? "org", ...(row.target_id ? { id: row.target_id } : {}) },
    result: row.outcome === "ok" ? "ok" : "error",
  };
  if (row.outcome !== "ok" && row.error_code) entry.error_code = row.error_code;
  if (row.country) entry.country = row.country;
  return entry;
}

/** Deletes up to `limit` rows older than the retention window. */
export async function purgeAudit(db: D1Database, now: number, retentionDays: number, limit: number): Promise<number> {
  return run(db, "DELETE FROM audit_log WHERE id IN (SELECT id FROM audit_log WHERE at < ? LIMIT ?)", now - retentionDays * 86_400, limit);
}
