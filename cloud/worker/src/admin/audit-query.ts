/**
 * Audit log queries for W25 and the admin console: filters, cursor pages, JSONL export, retention.
 *
 * Rows come from 04's `audit_log`, newest first, ordered by (at, id) so the cursor
 * `<at>.<id>` is stable while new rows arrive. Rows map to 02's `AuditEntry` with 04's
 * documented wire mapping (user/admin → user, setup/system → system, denied/failed →
 * error). The export streams every row matching the current filter as JSON Lines. The
 * retention sweep deletes only rows older than `audit_retention_days`.
 *
 * <module-headers:begin>
 * Uses:
 * src/admin/audit-query.ts
 * ├── @yaran/protocol:src/index.ts
 * └── src/admin/wire-time.ts
 * External: none
 *
 * Used by:
 * src/admin/audit-query.ts
 * ├── src/admin-api/routes.ts
 * ├── src/console/admin-pages-2.tsx
 * ├── src/console/admin-routes.ts
 * ├── src/scheduled/purge.ts
 * ├── test/admin-services.test.ts
 * └── test/audit.test.ts
 * <module-headers:end>
 */
import type { AuditEntry } from "@yaran/protocol";
import { wireTime } from "./wire-time.ts";

export interface AuditFilter {
  actor?: string | null;
  action?: string | null;
  target?: string | null;
  since?: string | null;
  until?: string | null;
}

interface AuditRow {
  id: string;
  at: number;
  actor_kind: string;
  actor_id: string | null;
  actor_email: string | null;
  action: string;
  target_kind: string | null;
  target_id: string | null;
  outcome: string;
  error_code: string | null;
  country: string | null;
}

export function toAuditEntry(r: AuditRow): AuditEntry {
  const kind = r.actor_kind === "user" || r.actor_kind === "admin" ? "user" : r.actor_kind === "machine" ? "machine" : "system";
  const entry: AuditEntry = {
    id: r.id,
    ts: wireTime(r.at),
    actor: { kind },
    action: r.action,
    target: { kind: (r.target_kind ?? "org") as AuditEntry["target"]["kind"] },
    result: r.outcome === "ok" ? "ok" : "error",
  };
  if (r.actor_id) entry.actor.id = r.actor_id;
  if (r.actor_email) entry.actor.email = r.actor_email;
  if (r.target_id) entry.target.id = r.target_id;
  if (r.outcome !== "ok" && r.error_code) entry.error_code = r.error_code;
  if (r.country) entry.country = r.country;
  return entry;
}

const toEpoch = (iso: string | null | undefined) => (iso ? Math.floor(Date.parse(iso) / 1000) : null);

/** Splits a `kind:id` target filter; a bare word filters by kind. */
function splitTarget(target: string | null | undefined): [string | null, string | null] {
  if (!target) return [null, null];
  const [kind, ...rest] = target.split(":");
  return [kind || null, rest.length ? rest.join(":") : null];
}

export async function queryAudit(db: D1Database, f: AuditFilter, limit: number, cursor?: string | null): Promise<{ items: AuditEntry[]; next_cursor: string | null }> {
  const [cAt, cId] = cursor ? [Number(cursor.split(".")[0]), cursor.slice(cursor.indexOf(".") + 1)] : [null, null];
  const [tKind, tId] = splitTarget(f.target);
  const actor = f.actor?.toLowerCase() ?? null;
  const { results } = await db
    .prepare(
      `SELECT a.id, a.at, a.actor_kind, a.actor_id, u.email AS actor_email, a.action, a.target_kind, a.target_id, a.outcome, a.error_code, a.country
       FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
       WHERE (?1 IS NULL OR a.actor_id = ?1 OR u.email = ?1)
         AND (?2 IS NULL OR a.action = ?2)
         AND (?3 IS NULL OR a.target_kind = ?3) AND (?4 IS NULL OR a.target_id = ?4)
         AND (?5 IS NULL OR a.at >= ?5) AND (?6 IS NULL OR a.at <= ?6)
         AND (?7 IS NULL OR a.at < ?7 OR (a.at = ?7 AND a.id < ?8))
       ORDER BY a.at DESC, a.id DESC LIMIT ?9`,
    )
    .bind(actor, f.action ?? null, tKind, tId, toEpoch(f.since), toEpoch(f.until), cAt, cId, limit + 1)
    .all<AuditRow>();
  const rows = results.slice(0, limit);
  const last = rows[rows.length - 1];
  return { items: rows.map(toAuditEntry), next_cursor: results.length > limit && last ? `${last.at}.${last.id}` : null };
}

/** Every matching entry as JSON Lines, a page at a time; `maxRows` bounds one export. */
export async function exportAuditJsonl(db: D1Database, f: AuditFilter, maxRows = 50_000): Promise<string> {
  const lines: string[] = [];
  let cursor: string | null = null;
  do {
    const page: { items: AuditEntry[]; next_cursor: string | null } = await queryAudit(db, f, 500, cursor);
    for (const e of page.items) lines.push(JSON.stringify(e));
    cursor = page.next_cursor;
  } while (cursor && lines.length < maxRows);
  return lines.length ? `${lines.join("\n")}\n` : "";
}

/**
 * The retention sweep (the body of 04's daily `purge_audit` task): deletes up to `limit`
 * rows older than the setting, returns how many, so one run stays inside the cron budget.
 */
export async function sweepAudit(db: D1Database, retentionDays: number, now: Date, limit: number): Promise<number> {
  const cutoff = Math.floor(now.getTime() / 1000) - retentionDays * 86_400;
  return (await db.prepare("DELETE FROM audit_log WHERE id IN (SELECT id FROM audit_log WHERE at < ? LIMIT ?)").bind(cutoff, limit).run()).meta.changes;
}
