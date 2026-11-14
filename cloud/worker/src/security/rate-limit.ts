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
 * Setup codes (tier 2 only): 5 attempts per 15 min per IP and 30 per day overall; past the
 * daily cap setup locks until the deployer sets a new `SETUP_CODE`.
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

export const SETUP_LIMITS = { perIp: 5, perIpWindowS: 15 * 60, perDay: 30 } as const;
export const SETUP_LOCK_PREFIX = "setup:lock:";

export type SetupAttempt = { kind: "ok" } | { kind: "limited"; retryAfter: number } | { kind: "locked" };

/** Records one setup-code attempt; `codeId` identifies the current SETUP_CODE (a hash prefix). */
export async function setupAttempt(db: D1Database, ip: string, codeId: string, now: number): Promise<SetupAttempt> {
  const lockKey = `${SETUP_LOCK_PREFIX}${codeId}`;
  if (await one(db, "SELECT 1 FROM rate_counters WHERE key = ?", lockKey)) return { kind: "locked" };
  const perIp = await strictHit(db, `setup:ip:${ip}`, SETUP_LIMITS.perIp, SETUP_LIMITS.perIpWindowS, now);
  if (!perIp.ok) return { kind: "limited", retryAfter: perIp.retryAfter };
  const daily = await strictHit(db, `setup:day:${codeId}`, SETUP_LIMITS.perDay, 86_400, now);
  if (daily.ok) return { kind: "ok" };
  await run(db, "INSERT OR IGNORE INTO rate_counters (key, window_start, count) VALUES (?, 0, 1)", lockKey);
  return { kind: "locked" };
}

/** Deletes counters from windows that ended over a day ago (setup locks are kept). */
export async function purgeRateCounters(db: D1Database, now: number): Promise<number> {
  return run(db, "DELETE FROM rate_counters WHERE window_start < ? AND key NOT LIKE 'setup:lock:%'", now - 2 * 86_400);
}
