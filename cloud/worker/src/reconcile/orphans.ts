/**
 * `cf_orphans` task: finds resources carrying this instance's marker that no live machine
 * owns, and deletes them after a grace period and two sightings.
 *
 * One resource kind per hourly run, rotating: tunnels (from `cf_status`'s cursor, no call),
 * DNS records (`comment.startswith`), Access apps and Access policies (`per_page=1000`, name
 * prefix). The app and policy lists also refresh the quota observation.
 *
 * - Only this instance's marker is ever considered; another instance's or unmarked
 *   resources are never touched.
 * - A candidate is deleted only when `seen_count >= 2`, it was first seen at least
 *   `orphan_grace_minutes` ago, its machine has no live op, no orphan of an earlier D21 kind
 *   (DNS → tunnel → app → policy) remains for that machine, and `orphan_cleanup` is `delete`.
 * - Every delete is idempotent (404 is done) and audited `orphan.deleted`.
 *
 * <module-headers:begin>
 * Uses:
 * src/reconcile/orphans.ts
 * ├── src/cloudflare/access.ts
 * ├── src/cloudflare/dns.ts
 * ├── src/cloudflare/errors.ts
 * ├── src/cloudflare/tunnels.ts
 * ├── src/provisioning/naming.ts
 * ├── src/provisioning/ports.ts
 * ├── src/provisioning/quota.ts
 * ├── src/provisioning/settings.ts
 * ├── src/reconcile/kit.ts
 * └── src/reconcile/status.ts
 * External: none
 *
 * Used by:
 * src/reconcile/orphans.ts
 * ├── src/reconcile/tasks.ts
 * └── test/provisioning/orphans.test.ts
 * <module-headers:end>
 */
import { deleteApp, deletePolicy, listApps, listPolicies } from "../cloudflare/access.ts";
import { deleteDnsRecord, listDnsByCommentPrefix } from "../cloudflare/dns.ts";
import { CfApiError } from "../cloudflare/errors.ts";
import { deleteTunnel, deleteTunnelConnections, patchTunnelSecret, randomTunnelSecret } from "../cloudflare/tunnels.ts";
import { markerPrefix, parseMarker, type MarkerKind } from "../provisioning/naming.ts";
import type { ProvCtx } from "../provisioning/ports.ts";
import { ORPHANS_TASK, readOrphansCursor, type QuotaObservation } from "../provisioning/quota.ts";
import { loadProvSettings, type ProvSettings } from "../provisioning/settings.ts";
import { DEFAULT_TASK_LIMITS, readTaskCursor, writeTaskCursorStmts, yieldingToBudget, type TaskLimits, type TaskOutcome } from "./kit.ts";
import { STATUS_TASK, type StatusCursor } from "./status.ts";

/** D21 teardown order; also the rotation order of the sweep. */
export const ORPHAN_KINDS: readonly MarkerKind[] = ["dns_record", "tunnel", "access_app", "access_policy"];

const COLUMN: Record<MarkerKind, string> = {
  dns_record: "dns_record_id",
  tunnel: "tunnel_id",
  access_app: "access_app_id",
  access_policy: "access_policy_id",
};

interface Candidate {
  id: string;
  marker: string;
  machineId: string;
}

interface OrphanRow {
  resource_kind: MarkerKind;
  resource_id: string;
  marker: string;
  first_seen_at: number;
  seen_count: number;
}

async function listCandidates(ctx: ProvCtx, s: ProvSettings, kind: MarkerKind, quota: Partial<QuotaObservation>): Promise<Candidate[]> {
  const prefix = markerPrefix(kind, s.instanceId);
  const p = "background" as const;
  let found: Array<{ id: string; marker: string | null | undefined }>;
  switch (kind) {
    case "tunnel": {
      const c = await readTaskCursor<StatusCursor>(ctx, STATUS_TASK);
      found = (c.others ?? []).map((t) => ({ id: t.id, marker: t.name }));
      if (c.tunnels_total !== undefined) quota.tunnels_total = c.tunnels_total;
      break;
    }
    case "dns_record":
      found = (await listDnsByCommentPrefix(ctx.cf, s.zoneId, prefix, p)).items.map((r) => ({ id: r.id, marker: r.comment }));
      break;
    case "access_app": {
      const r = await listApps(ctx.cf, s.accountId, p);
      quota.apps_total = r.total;
      found = r.items.map((a) => ({ id: a.id, marker: a.name }));
      break;
    }
    case "access_policy": {
      const r = await listPolicies(ctx.cf, s.accountId, p);
      quota.policies_total = r.total;
      found = r.items.map((x) => ({ id: x.id, marker: x.name }));
      break;
    }
  }
  const out: Candidate[] = [];
  for (const f of found) {
    const machineId = parseMarker(kind, s.instanceId, f.marker);
    if (machineId && f.marker) out.push({ id: f.id, marker: f.marker, machineId });
  }
  return out;
}

/** Candidates whose machine is missing, revoked or failed, or records a different id. */
async function orphansOf(ctx: ProvCtx, kind: MarkerKind, cands: Candidate[]): Promise<Candidate[]> {
  const owned = new Map<string, { status: string; rid: string | null }>();
  const ids = [...new Set(cands.map((c) => c.machineId))];
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const { results } = await ctx.db
      .prepare(`SELECT id, status, ${COLUMN[kind]} AS rid FROM machines WHERE id IN (${chunk.map(() => "?").join(",")})`)
      .bind(...chunk)
      .all<{ id: string; status: string; rid: string | null }>();
    for (const r of results) owned.set(r.id, r);
  }
  return cands.filter((c) => {
    const m = owned.get(c.machineId);
    return !m || m.status === "revoked" || m.status === "failed" || m.rid !== c.id;
  });
}

export function runCfOrphans(ctx: ProvCtx, limits: TaskLimits = DEFAULT_TASK_LIMITS): Promise<TaskOutcome> {
  return yieldingToBudget(ORPHANS_TASK, ctx, async () => {
    const s = await loadProvSettings(ctx);
    ctx.cf.budget.backgroundReserve = s.apiBackgroundReserve;
    const now = ctx.now();
    const cursor = await readOrphansCursor(ctx);
    const index = typeof cursor["kind_index"] === "number" ? (cursor["kind_index"] as number) : 0;
    const kind = ORPHAN_KINDS[index % ORPHAN_KINDS.length] as MarkerKind;
    const quota: Partial<QuotaObservation> = { ...cursor.quota };
    const orphans = await orphansOf(ctx, kind, await listCandidates(ctx, s, kind, quota));
    const stmts = orphans.flatMap((o) => [
      ctx.db
        .prepare("INSERT OR IGNORE INTO cf_orphans (resource_kind, resource_id, marker, first_seen_at, last_seen_at, seen_count) VALUES (?, ?, ?, ?, ?, 0)")
        .bind(kind, o.id, o.marker, now, now),
      ctx.db.prepare("UPDATE cf_orphans SET seen_count = seen_count + 1, last_seen_at = ? WHERE resource_kind = ? AND resource_id = ?").bind(now, kind, o.id),
    ]);
    stmts.push(ctx.db.prepare("DELETE FROM cf_orphans WHERE resource_kind = ? AND last_seen_at < ?").bind(kind, now));
    const nextQuota = { ...quota, observed_at: kind === "access_app" || kind === "access_policy" ? now : (quota.observed_at ?? 0) };
    stmts.push(...writeTaskCursorStmts(ctx, ORPHANS_TASK, { ...cursor, kind_index: (index + 1) % ORPHAN_KINDS.length, quota: nextQuota }));
    await ctx.db.batch(stmts);
    const { results: rows } = await ctx.db
      .prepare("SELECT resource_kind, resource_id, marker, first_seen_at, seen_count FROM cf_orphans WHERE resource_kind = ?")
      .bind(kind)
      .all<OrphanRow>();
    for (const r of rows.filter((x) => x.seen_count === 1)) {
      await ctx.audit({ action: "orphan.found", target: { kind: "org", id: null }, outcome: "ok", detail: { resource_kind: kind, resource_id: r.resource_id, marker: r.marker } });
    }
    if (s.orphanCleanup === "report") return { ok: true, note: `${rows.length} ${kind} orphans listed (report mode deletes nothing)` };
    let deleted = 0;
    const startCalls = ctx.cf.calls;
    for (const r of rows) {
      if (ctx.cf.calls - startCalls + 4 > limits.subrequests) break;
      if (!(await deletable(ctx, s, r, now))) continue;
      await deleteOrphanResource(ctx, s, r.resource_kind, r.resource_id, r.marker);
      deleted++;
    }
    return { ok: true, note: `${rows.length} ${kind} orphans tracked, ${deleted} deleted` };
  });
}

async function deletable(ctx: ProvCtx, s: ProvSettings, r: OrphanRow, now: number): Promise<boolean> {
  if (r.seen_count < 2 || now - r.first_seen_at < s.orphanGraceMinutes * 60) return false;
  const machineId = parseMarker(r.resource_kind, s.instanceId, r.marker);
  if (!machineId) return false;
  const earlier = ORPHAN_KINDS.slice(0, ORPHAN_KINDS.indexOf(r.resource_kind));
  const blocking = await ctx.db
    .prepare(
      `SELECT 1 AS x FROM provisioning_ops WHERE machine_id = ? AND state IN ('pending','running','compensating')
       UNION ALL SELECT 1 FROM cf_orphans WHERE resource_kind IN (${earlier.map(() => "?").join(",") || "''"}) AND marker LIKE ?`,
    )
    .bind(machineId, ...earlier, `%${machineId}`)
    .first();
  return !blocking;
}

/**
 * Deletes one orphan in D21 order for its kind (a tunnel: invalidate, evict, delete), then
 * forgets it. Also 07's per-row delete in `report` mode.
 */
export async function deleteOrphanResource(ctx: ProvCtx, s: ProvSettings, kind: MarkerKind, id: string, marker: string): Promise<void> {
  if (!parseMarker(kind, s.instanceId, marker)) throw new Error(`refusing to delete ${kind} ${id}: not this instance's marker`);
  const p = "background" as const;
  const gone = async (f: () => Promise<unknown>) => {
    try {
      await f();
    } catch (err) {
      if (!(err instanceof CfApiError && err.kind === "not_found")) throw err;
    }
  };
  switch (kind) {
    case "dns_record":
      await gone(() => deleteDnsRecord(ctx.cf, s.zoneId, id, p));
      break;
    case "tunnel":
      await gone(() => patchTunnelSecret(ctx.cf, s.accountId, id, randomTunnelSecret(), p));
      await gone(() => deleteTunnelConnections(ctx.cf, s.accountId, id, p));
      await gone(() => deleteTunnel(ctx.cf, s.accountId, id, p));
      break;
    case "access_app":
      await gone(() => deleteApp(ctx.cf, s.accountId, id, p));
      break;
    case "access_policy":
      await gone(() => deletePolicy(ctx.cf, s.accountId, id, p));
      break;
  }
  await ctx.db.prepare("DELETE FROM cf_orphans WHERE resource_kind = ? AND resource_id = ?").bind(kind, id).run();
  await ctx.audit({ action: "orphan.deleted", target: { kind: "org", id: null }, outcome: "ok", detail: { resource_kind: kind, resource_id: id, marker } });
}
