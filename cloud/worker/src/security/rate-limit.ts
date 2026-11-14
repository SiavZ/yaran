/**
 * Rate limiting in two tiers, plus the setup-code attempt policy.
 *
 * Tier 1 is the Rate Limiting binding (per location, eventually consistent, cheap). Tier 2
 * is a fixed-window counter in D1 (`rate_counters`) for limits that must hold globally,
 * and the fallback for any bucket whose binding this deploy lacks (plan availability of the
 * binding is UNVERIFIED, so a missing binding is not an error).
 *
 * | Bucket    | Binding     | Key                         | Limit       |
 * | `ip`      | `RL_IP`     | client IP, every route      | 300 / 60 s  |
 * | `auth`    | `RL_AUTH`   | client IP                   | 20 / 60 s   |
 * | `machine` | `RL_MACHINE`| machine id (else client IP) | 120 / 60 s  |
 *
 * Setup codes (tier 2 only), all per client address so a stranger can never lock the
 * admin out: 5 tries per 15 min and 30 a day (correct codes included) are temporary
 * limits; 20 wrong codes lock that address until the deployer sets a new `SETUP_CODE`. A
 * global backstop bounds a stranger spreading guesses over many addresses: past 100 wrong
 * codes a day, one wrong code locks its address, while an address that has not failed can
 * still try the right code.
 *
 * <module-headers:begin>
 * Uses:
 * src/security/rate-limit.ts
 * ├── src/db/client.ts
 * ├── src/env.ts
 * ├── src/http/context.ts
 * ├── src/http/responses.ts
 * └── src/http/routes.ts
 * External: none
 *
 * Used by:
 * src/security/rate-limit.ts
 * ├── src/http/pipeline.ts
 * ├── src/routes/phase06-context.ts
 * ├── src/scheduled/purge.ts
 * └── test/rate-limit.test.ts
 * <module-headers:end>
 */
import { rateLimitBinding, type RateLimitName } from "../env.ts";
import { batch, one, run, stmt } from "../db/client.ts";
import type { AppContext } from "../http/context.ts";
import { HttpError } from "../http/responses.ts";
import type { RateBucket } from "../http/routes.ts";

export const BUCKETS: Record<RateBucket, { binding: RateLimitName; limit: number; period: number }> = {
  ip: { binding: "RL_IP", limit: 300, period: 60 },
  auth: { binding: "RL_AUTH", limit: 20, period: 60 },
  machine: { binding: "RL_MACHINE", limit: 120, period: 60 },
};

export interface StrictResult {
  ok: boolean;
  /** Seconds until the window resets. */
  retryAfter: number;
}

/** One hit on a fixed-window D1 counter; refused once `limit` hits are in the window. */
export async function strictHit(db: D1Database, key: string, limit: number, windowS: number, now: number): Promise<StrictResult> {
  const windowStart = now - (now % windowS);
  const [, changed] = await batch(db, [
    stmt(db, "INSERT OR IGNORE INTO rate_counters (key, window_start, count) VALUES (?, ?, 0)", key, windowStart),
    stmt(db, "UPDATE rate_counters SET count = count + 1 WHERE key = ? AND window_start = ? AND count < ?", key, windowStart, limit),
  ]);
  return { ok: changed === 1, retryAfter: windowStart + windowS - now };
}

const limited = (retryAfter: number) =>
  new HttpError("rate_limited", "Too many requests; slow down and retry after the indicated delay.", {
    headers: { "Retry-After": String(Math.max(1, retryAfter)) },
  });

/** Counts one request against a bucket; throws `429 rate_limited` when over. */
export async function hitBucket(ctx: AppContext, bucket: RateBucket, key: string): Promise<void> {
  const spec = BUCKETS[bucket];
  const binding = rateLimitBinding(ctx.env, spec.binding);
  if (binding) {
    if (!(await binding.limit({ key: `${bucket}:${key}` })).success) throw limited(spec.period);
    return;
  }
  const result = await strictHit(ctx.db, `rl:${bucket}:${key}`, spec.limit, spec.period, ctx.now());
  if (!result.ok) throw limited(result.retryAfter);
}

/** The per-IP bucket for every request, plus the route's own stricter bucket. */
export async function enforceRouteLimit(ctx: AppContext, bucket: RateBucket, machineId: string | null): Promise<void> {
  const ip = ctx.ip ?? "unknown";
  await hitBucket(ctx, "ip", ip);
  if (bucket === "auth") await hitBucket(ctx, "auth", ip);
  else if (bucket === "machine") await hitBucket(ctx, "machine", machineId ?? ip);
}

export const SETUP_LIMITS = {
  perIp: 5,
  perIpWindowS: 15 * 60,
  perIpDay: 30,
  lockAfterFailures: 20,
  globalFailureBackstop: 100,
} as const;
export const SETUP_LOCK_PREFIX = "setup:lock:";

/** Why an address is locked: its own 20 wrong codes, or one wrong code past the backstop. */
export type SetupLockReason = "failures" | "backstop";
export type SetupAttempt =
  | { kind: "ok" }
  | { kind: "limited"; reason: "window" | "day"; retryAfter: number }
  | { kind: "locked"; reason: SetupLockReason };

// Lock and failure rows use window 0 so they outlive the fixed windows; both are keyed by
// the code in force, so a new `SETUP_CODE` starts every address over.
const lockKey = (codeId: string, ip: string) => `${SETUP_LOCK_PREFIX}${codeId}:${ip}`;

/** The lock on `ip` for the current code, if any. */
export async function setupLock(db: D1Database, ip: string, codeId: string): Promise<SetupLockReason | null> {
  const row = await one<{ count: number }>(db, "SELECT count FROM rate_counters WHERE key = ?", lockKey(codeId, ip));
  if (!row) return null;
  return row.count === 2 ? "backstop" : "failures";
}

/** Records one setup-code try from `ip`; `codeId` identifies the current SETUP_CODE (a hash prefix). */
export async function setupAttempt(db: D1Database, ip: string, codeId: string, now: number): Promise<SetupAttempt> {
  const locked = await setupLock(db, ip, codeId);
  if (locked) return { kind: "locked", reason: locked };
  const window = await strictHit(db, `setup:ip:${ip}`, SETUP_LIMITS.perIp, SETUP_LIMITS.perIpWindowS, now);
  if (!window.ok) return { kind: "limited", reason: "window", retryAfter: window.retryAfter };
  const day = await strictHit(db, `setup:day:${ip}`, SETUP_LIMITS.perIpDay, 86_400, now);
  if (!day.ok) return { kind: "limited", reason: "day", retryAfter: day.retryAfter };
  return { kind: "ok" };
}

/** Counts one wrong setup code from `ip`, locking the address when a limit is reached. */
export async function setupFailure(
  db: D1Database,
  ip: string,
  codeId: string,
  now: number,
): Promise<{ kind: "counted" } | { kind: "locked"; reason: SetupLockReason }> {
  const failKey = `setup:fail:${codeId}:${ip}`;
  const dayKey = `setup:failday:${codeId}`;
  const day = now - (now % 86_400);
  await batch(db, [
    stmt(db, "INSERT INTO rate_counters (key, window_start, count) VALUES (?, 0, 1) ON CONFLICT (key, window_start) DO UPDATE SET count = count + 1", failKey),
    stmt(db, "INSERT INTO rate_counters (key, window_start, count) VALUES (?, ?, 1) ON CONFLICT (key, window_start) DO UPDATE SET count = count + 1", dayKey, day),
  ]);
  const mine = (await one<{ count: number }>(db, "SELECT count FROM rate_counters WHERE key = ? AND window_start = 0", failKey))?.count ?? 0;
  const all = (await one<{ count: number }>(db, "SELECT count FROM rate_counters WHERE key = ? AND window_start = ?", dayKey, day))?.count ?? 0;
  const reason: SetupLockReason | null =
    mine >= SETUP_LIMITS.lockAfterFailures ? "failures" : all > SETUP_LIMITS.globalFailureBackstop ? "backstop" : null;
  if (!reason) return { kind: "counted" };
  // count 1 = locked by its own failures, 2 = by the backstop (read back by setupLock).
  await run(db, "INSERT OR IGNORE INTO rate_counters (key, window_start, count) VALUES (?, 0, ?)", lockKey(codeId, ip), reason === "backstop" ? 2 : 1);
  return { kind: "locked", reason };
}

/** Deletes counters from windows that ended over a day ago (setup locks and failure counts are kept). */
export async function purgeRateCounters(db: D1Database, now: number): Promise<number> {
  return run(db, "DELETE FROM rate_counters WHERE window_start < ? AND window_start <> 0", now - 2 * 86_400);
}
