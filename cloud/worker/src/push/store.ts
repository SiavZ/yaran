/**
 * Every SQL statement the push module runs against D1, in one place: event-id dedupe,
 * fan-out candidates, the consumer's batch read, delivery-state writes and daily counters.
 *
 * - Avoids RETURNING and ON CONFLICT DO UPDATE (04 §12: D1's SQLite version is
 *   undocumented); uses INSERT OR IGNORE, conditional UPDATE and meta.changes.
 * - State writes are conditional, so an unchanged state costs no row write (Free plan).
 * - A push answer never deletes or revokes a device; `gone` clears only the subscription.
 *
 * <module-headers:begin>
 * Uses:
 * src/push/store.ts
 * ├── @yaran/protocol:src/index.ts
 * └── src/push/types.ts
 * External: none
 *
 * Used by:
 * src/push/store.ts
 * ├── src/push/consumer.ts
 * ├── src/push/events_route.ts
 * ├── src/push/fanout.ts
 * ├── src/push/routes.ts
 * ├── src/push/test_route.ts
 * ├── test/devices/devices-repo.test.ts
 * ├── test/push/consumer.test.ts
 * └── test/push/routes.test.ts
 * <module-headers:end>
 */
import type { PushChannel } from "@yaran/protocol";
import { toBytes } from "./types.ts";

export const EVENT_DEDUPE_S = 24 * 3600;
export const FAILING_AFTER = 5;
const OK_WRITE_INTERVAL_S = 3600;

/** Records event ids for a machine; returns the ids seen for the first time. */
export async function claimEventIds(db: D1Database, machineId: string, ids: string[], now: number): Promise<Set<string>> {
  const stmt = "INSERT OR IGNORE INTO event_ids (machine_id, id, seen_at) VALUES (?, ?, ?)";
  const results = await db.batch(ids.map((id) => db.prepare(stmt).bind(machineId, id, now)));
  return new Set(ids.filter((_, i) => results[i]!.meta.changes === 1));
}

/** Forgets ids whose pushes could not be queued, so the machine's retry is not a duplicate. */
export async function releaseEventIds(db: D1Database, machineId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.batch(ids.map((id) => db.prepare("DELETE FROM event_ids WHERE machine_id = ? AND id = ?").bind(machineId, id)));
}

/** Drops dedupe rows older than 24 h; returns how many went. */
/** Deletes up to `limit` event ids older than the dedupe window. */
export async function purgeEventIds(db: D1Database, now: number, limit = 500): Promise<number> {
  const r = await db
    .prepare("DELETE FROM event_ids WHERE (machine_id, id) IN (SELECT machine_id, id FROM event_ids WHERE seen_at < ? LIMIT ?)")
    .bind(now - EVENT_DEDUPE_S, limit)
    .run();
  return r.meta.changes;
}

export interface MuteFields {
  mute_all: boolean;
  muted_until: number | null;
}

export interface FanoutDevice extends MuteFields {
  id: string;
  channel: PushChannel;
  endpoint_host: string;
  machine_muted: boolean;
}

/** The owner's subscribed, healthy devices with their mute fields for one machine. */
export async function fanoutCandidates(db: D1Database, userId: string, machineId: string): Promise<FanoutDevice[]> {
  const { results } = await db
    .prepare(
      `SELECT d.id, d.push_kind, d.endpoint_host, d.mute_all, d.muted_until,
              EXISTS (SELECT 1 FROM device_machine_mutes m WHERE m.device_id = d.id AND m.machine_id = ?) AS machine_muted
         FROM devices d
        WHERE d.user_id = ? AND d.revoked_at IS NULL AND d.push_kind <> 'none'
          AND d.endpoint_enc IS NOT NULL AND d.endpoint_host IS NOT NULL
          AND d.push_state IN ('active', 'failing')`,
    )
    .bind(machineId, userId)
    .all<Record<string, unknown>>();
  return results.map((r) => ({
    id: String(r.id),
    channel: r.push_kind as PushChannel,
    endpoint_host: String(r.endpoint_host),
    mute_all: Number(r.mute_all) === 1,
    muted_until: r.muted_until === null ? null : Number(r.muted_until),
    machine_muted: Number(r.machine_muted) === 1,
  }));
}

/** The device id when it belongs to the user and is not revoked. */
export async function ownedDevice(db: D1Database, userId: string, deviceId: string): Promise<string | null> {
  const row = await db.prepare("SELECT id FROM devices WHERE id = ? AND user_id = ? AND revoked_at IS NULL").bind(deviceId, userId).first<{ id: string }>();
  return row?.id ?? null;
}

export interface SendDevice extends MuteFields {
  id: string;
  channel: PushChannel | "none";
  revoked: boolean;
  push_state: string;
  endpoint_enc: string | null;
  endpoint_host: string | null;
  p256dh: Uint8Array | null;
  auth_enc: string | null;
  muted_machines: Set<string>;
}

/** One read for a consumer batch: the devices and their per-machine mutes. */
export async function loadSendDevices(db: D1Database, ids: string[]): Promise<Map<string, SendDevice>> {
  const out = new Map<string, SendDevice>();
  if (ids.length === 0) return out;
  const marks = ids.map(() => "?").join(", ");
  const [devices, mutes] = await db.batch([
    db
      .prepare(
        `SELECT id, revoked_at, push_kind, endpoint_enc, endpoint_host, p256dh, auth_enc, push_state, mute_all, muted_until
           FROM devices WHERE id IN (${marks})`,
      )
      .bind(...ids),
    db.prepare(`SELECT device_id, machine_id FROM device_machine_mutes WHERE device_id IN (${marks})`).bind(...ids),
  ]);
  for (const r of devices!.results as Record<string, unknown>[]) {
    out.set(String(r.id), {
      id: String(r.id),
      channel: r.push_kind as SendDevice["channel"],
      revoked: r.revoked_at !== null,
      push_state: String(r.push_state),
      endpoint_enc: (r.endpoint_enc as string | null) ?? null,
      endpoint_host: (r.endpoint_host as string | null) ?? null,
      p256dh: toBytes(r.p256dh),
      auth_enc: (r.auth_enc as string | null) ?? null,
      mute_all: Number(r.mute_all) === 1,
      muted_until: r.muted_until === null ? null : Number(r.muted_until),
      muted_machines: new Set(),
    });
  }
  for (const r of mutes!.results as { device_id: string; machine_id: string }[]) out.get(r.device_id)?.muted_machines.add(r.machine_id);
  return out;
}

/** 2xx: active with no failures (written only on change), success time at most hourly. */
/** Records a 2xx; returns the rows written, so a test can see the write budget is kept. */
export async function markOk(db: D1Database, id: string, now: number): Promise<number> {
  const results = await db.batch([
    db
      .prepare("UPDATE devices SET push_state = 'active', consecutive_failures = 0 WHERE id = ? AND revoked_at IS NULL AND (push_state <> 'active' OR consecutive_failures <> 0)")
      .bind(id),
    db
      .prepare("UPDATE devices SET last_push_ok_at = ? WHERE id = ? AND (last_push_ok_at IS NULL OR last_push_ok_at <= ?)")
      .bind(now, id, now - OK_WRITE_INTERVAL_S),
  ]);
  return results.reduce((n, r) => n + (r.meta.changes ?? 0), 0);
}

/** 404/410: clears the subscription and marks gone, keeping the row; true when it changed. */
export async function markGone(db: D1Database, id: string): Promise<boolean> {
  const r = await db
    .prepare(
      `UPDATE devices SET endpoint_enc = NULL, endpoint_host = NULL, p256dh = NULL, auth_enc = NULL, push_state = 'gone'
        WHERE id = ? AND push_state <> 'gone'`,
    )
    .bind(id)
    .run();
  return r.meta.changes === 1;
}

/** 401/403: the subscription was made for another VAPID key; true when it changed. */
export async function markAuthFailed(db: D1Database, id: string): Promise<boolean> {
  const r = await db.prepare("UPDATE devices SET push_state = 'auth_failed' WHERE id = ? AND push_state IN ('active', 'failing')").bind(id).run();
  return r.meta.changes === 1;
}

/** An exhausted push: counts it and returns true when this one turned the device failing. */
export async function recordExhausted(db: D1Database, id: string): Promise<boolean> {
  const [, turned] = await db.batch([
    db.prepare("UPDATE devices SET consecutive_failures = consecutive_failures + 1 WHERE id = ?").bind(id),
    db.prepare("UPDATE devices SET push_state = 'failing' WHERE id = ? AND push_state = 'active' AND consecutive_failures >= ?").bind(id, FAILING_AFTER),
  ]);
  return turned!.meta.changes === 1;
}

export interface StatDeltas {
  accepted?: number;
  delivered?: number;
  failed?: number;
  gone?: number;
}

/** UTC day of a Unix time, as push_stats keys it. */
export function statDay(now: number): string {
  return new Date(now * 1000).toISOString().slice(0, 10);
}

/** Adds to today's counters (two statements, no upsert syntax). */
export async function bumpStats(db: D1Database, now: number, d: StatDeltas): Promise<void> {
  const v = [d.accepted ?? 0, d.delivered ?? 0, d.failed ?? 0, d.gone ?? 0];
  if (v.every((n) => n === 0)) return;
  const day = statDay(now);
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO push_stats (day) VALUES (?)").bind(day),
    db.prepare("UPDATE push_stats SET accepted = accepted + ?, delivered = delivered + ?, failed = failed + ?, gone = gone + ? WHERE day = ?").bind(...v, day),
  ]);
}
