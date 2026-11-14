/**
 * Pair-request repository: the D1 side of the pairing state machine
 * (`pending → confirmed → claimed`, `pending → cancelled`, `pending | confirmed → expired`).
 *
 * Every transition is one conditional `UPDATE … WHERE status = <expected>` checked through
 * `meta.changes`, so two racing calls can never both win (04 avoids `RETURNING`).
 *
 * - Stores only hashes of the code, state and csrf; the state is also kept sealed
 *   (purpose `pair_state`) because the confirm POST must echo it to the callback.
 * - The pair request lives 10 minutes; its code 120 seconds from issue.
 *
 * <module-headers:begin>
 * Uses:
 * src/pairing/pair-requests.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/pairing/pkce.ts
 * └── src/seams/foundation.ts
 * External: none
 *
 * Used by:
 * src/pairing/pair-requests.ts
 * ├── src/machine-api/claim.ts
 * ├── src/pairing/authorize-route.ts
 * ├── src/pairing/sweep.ts
 * ├── test/pairing/pair-requests.test.ts
 * └── test/phase06/harness.ts
 * <module-headers:end>
 */
import { timingSafeEqual, type MachineKey } from "@yaran/protocol";
import type { FoundationCtx } from "../seams/foundation.ts";
import { sha256Text } from "./pkce.ts";

export const PAIR_REQUEST_TTL_S = 600;
export const PAIR_CODE_TTL_S = 120;

export type PairStatus = "pending" | "confirmed" | "claimed" | "expired" | "cancelled";

export interface PairRequestRow {
  id: string;
  user_id: string;
  state_enc: string;
  code_challenge: string;
  machine_public_key: ArrayBuffer;
  machine_name: string;
  callback_port: number;
  origin_port: number;
  yaran_version: string | null;
  machine_id: string | null;
  replaces_machine_id: string | null;
  csrf_hash: ArrayBuffer | null;
  status: PairStatus;
  created_at: number;
  expires_at: number;
  code_expires_at: number | null;
}

export interface NewPairRequest {
  userId: string;
  state: string;
  codeChallenge: string;
  machinePublicKey: Uint8Array;
  machineName: string;
  callbackPort: number;
  originPort: number;
  yaranVersion: string;
  csrf: string;
}

const stateAad = (id: string) => `pair_requests.state_enc:${id}`;

export async function createPending(ctx: FoundationCtx, p: NewPairRequest): Promise<string> {
  const id = crypto.randomUUID();
  const now = ctx.now();
  await ctx.db
    .prepare(
      `INSERT INTO pair_requests (id, user_id, state_hash, state_enc, code_challenge, machine_public_key, machine_name,
         callback_port, origin_port, yaran_version, csrf_hash, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    )
    .bind(
      id, p.userId, await sha256Text(p.state), await ctx.dataKey.seal("pair_state", stateAad(id), p.state), p.codeChallenge,
      p.machinePublicKey, p.machineName, p.callbackPort, p.originPort, p.yaranVersion, await sha256Text(p.csrf), now, now + PAIR_REQUEST_TTL_S,
    )
    .run();
  return id;
}

/** The caller's own request, whatever its status (null for another user's id). */
export function getForUser(ctx: FoundationCtx, id: string, userId: string): Promise<PairRequestRow | null> {
  return ctx.db.prepare("SELECT * FROM pair_requests WHERE id = ? AND user_id = ?").bind(id, userId).first<PairRequestRow>();
}

export function openState(ctx: FoundationCtx, row: PairRequestRow): Promise<string> {
  return ctx.dataKey.open("pair_state", stateAad(row.id), row.state_enc);
}

/** Constant-time check of a submitted csrf against the stored hash. */
export async function csrfMatches(row: PairRequestRow, csrf: string): Promise<boolean> {
  return row.csrf_hash !== null && timingSafeEqual(new Uint8Array(row.csrf_hash), await sha256Text(csrf));
}

async function transition(ctx: FoundationCtx, sql: string, ...binds: unknown[]): Promise<boolean> {
  return (await ctx.db.prepare(sql).bind(...binds).run()).meta.changes === 1;
}

/** pending → cancelled (Deny). */
export function deny(ctx: FoundationCtx, id: string): Promise<boolean> {
  return transition(ctx, "UPDATE pair_requests SET status = 'cancelled' WHERE id = ? AND status = 'pending'", id);
}

/** Records the machine allocated for an approve; only the first approve links one. */
export function linkMachine(ctx: FoundationCtx, id: string, machineId: string, replaces: string | null): Promise<boolean> {
  return transition(
    ctx,
    "UPDATE pair_requests SET machine_id = ?, replaces_machine_id = ? WHERE id = ? AND status = 'pending' AND machine_id IS NULL",
    machineId, replaces, id,
  );
}

/** pending → confirmed with the code's hash; the code lives PAIR_CODE_TTL_S from now. */
export async function approve(ctx: FoundationCtx, id: string, code: string): Promise<boolean> {
  const now = ctx.now();
  return transition(
    ctx,
    "UPDATE pair_requests SET status = 'confirmed', code_hash = ?, code_expires_at = ?, csrf_hash = NULL WHERE id = ? AND status = 'pending' AND expires_at >= ?",
    await sha256Text(code), now + PAIR_CODE_TTL_S, id, now,
  );
}

/** The confirmed request a live, unexpired code selects. */
export async function findByCode(ctx: FoundationCtx, code: string): Promise<PairRequestRow | null> {
  const now = ctx.now();
  return ctx.db
    .prepare("SELECT * FROM pair_requests WHERE code_hash = ? AND status = 'confirmed' AND code_expires_at >= ? AND expires_at >= ?")
    .bind(await sha256Text(code), now, now)
    .first<PairRequestRow>();
}

/** 04's `pair_request` key resolver for W4: the machine key recorded with a live code. */
export async function pairCodeKey(ctx: FoundationCtx, code: string): Promise<MachineKey | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(code)) return null;
  const row = await findByCode(ctx, code);
  return row ? { publicKey: new Uint8Array(row.machine_public_key), revoked: false } : null;
}

/** confirmed → claimed; false for the loser of a race or an expired code. */
export async function claim(ctx: FoundationCtx, id: string, code: string): Promise<boolean> {
  const now = ctx.now();
  return transition(
    ctx,
    "UPDATE pair_requests SET status = 'claimed', claimed_at = ? WHERE id = ? AND code_hash = ? AND status = 'confirmed' AND code_expires_at >= ?",
    now, id, await sha256Text(code), now,
  );
}

/** Up to `limit` pending or confirmed requests past their 10 minutes. */
export async function dueForExpiry(ctx: FoundationCtx, limit: number): Promise<Pick<PairRequestRow, "id" | "user_id" | "machine_id" | "status">[]> {
  const r = await ctx.db
    .prepare("SELECT id, user_id, machine_id, status FROM pair_requests WHERE status IN ('pending','confirmed') AND expires_at < ? ORDER BY expires_at LIMIT ?")
    .bind(ctx.now(), limit)
    .all<Pick<PairRequestRow, "id" | "user_id" | "machine_id" | "status">>();
  return r.results;
}

/** pending | confirmed → expired. */
export function expire(ctx: FoundationCtx, id: string): Promise<boolean> {
  return transition(ctx, "UPDATE pair_requests SET status = 'expired' WHERE id = ? AND status IN ('pending','confirmed') AND expires_at < ?", id, ctx.now());
}
