/**
 * Cloudflare API budget: parses the `Ratelimit` header, gates calls by priority, and persists
 * the last observation in `cf_api_budget` (1,200 calls per 5 min per token).
 *
 * The Worker never spends a call it knows will 429: a known `blocked_until` refuses every
 * call before the network, `interactive` work runs while more than 20 calls remain, and
 * `background` work (reconcile) only above `api_background_reserve`.
 *
 * - Reads the row at most once and writes it at most once per invocation (`flush`).
 * - Going over the limit blocks every call for 5 min, so a 429 without `retry-after` blocks
 *   for 300 s.
 * - Header shape: `"<name>";r=<remaining>;t=<seconds>` (developers.cloudflare.com
 *   fundamentals/api/reference/limits, 2026-08-25).
 *
 * <module-headers:begin>
 * Uses:
 * src/cloudflare/budget.ts
 * ├── src/cloudflare/errors.ts
 * └── src/provisioning/ports.ts
 * External: none
 *
 * Used by:
 * src/cloudflare/budget.ts
 * ├── src/cloudflare/access.ts
 * ├── src/cloudflare/client.ts
 * ├── src/cloudflare/dns.ts
 * ├── src/cloudflare/paginate.ts
 * ├── src/cloudflare/tunnels.ts
 * ├── src/provisioning/context.ts
 * ├── src/provisioning/engine.ts
 * ├── src/provisioning/quota.ts
 * ├── test/provisioning/budget.test.ts
 * ├── test/provisioning/client.test.ts
 * ├── test/provisioning/helpers/world.ts
 * └── test/provisioning/paginate.test.ts
 * <module-headers:end>
 */
import { CfApiError } from "./errors.ts";
import type { D1Like } from "../provisioning/ports.ts";

export type Priority = "interactive" | "background";

export const INTERACTIVE_FLOOR = 20;
export const DEFAULT_BLOCK_SECONDS = 300;

export interface RatelimitObservation {
  remaining: number;
  resetSeconds: number;
}

/** Parses `Ratelimit`; null for an absent or malformed header. */
export function parseRatelimit(header: string | null): RatelimitObservation | null {
  if (!header) return null;
  for (const item of header.split(",")) {
    const r = /;\s*r=(\d+)/.exec(item);
    const t = /;\s*t=(\d+)/.exec(item);
    if (r?.[1] !== undefined && t?.[1] !== undefined) {
      return { remaining: Number(r[1]), resetSeconds: Number(t[1]) };
    }
  }
  return null;
}

interface BudgetRow {
  remaining: number | null;
  reset_at: number | null;
  blocked_until: number | null;
}

export class ApiBudget {
  private row: BudgetRow | null = null;
  private loaded = false;
  private dirty = false;

  constructor(
    private readonly db: D1Like,
    private readonly now: () => number,
    /** `api_background_reserve`; settable once settings are read. */
    public backgroundReserve = 600,
  ) {}

  private async load(): Promise<BudgetRow> {
    if (!this.loaded) {
      this.row = await this.db
        .prepare("SELECT remaining, reset_at, blocked_until FROM cf_api_budget WHERE id = 1")
        .first<BudgetRow>();
      this.loaded = true;
    }
    this.row ??= { remaining: null, reset_at: null, blocked_until: null };
    return this.row;
  }

  /** Throws `rate_limited` (no network call made) when the call must not be spent. */
  async gate(priority: Priority, endpoint: string): Promise<void> {
    const row = await this.load();
    const now = this.now();
    if (row.blocked_until !== null && row.blocked_until > now) {
      throw new CfApiError("rate_limited", null, endpoint, [], row.blocked_until - now, `${endpoint} skipped: Cloudflare API blocked until ${row.blocked_until}`);
    }
    // A window that has reset is full again; an unknown remaining is not a refusal.
    if (row.remaining === null || row.reset_at === null || row.reset_at <= now) return;
    const floor = priority === "interactive" ? INTERACTIVE_FLOOR : this.backgroundReserve;
    if (row.remaining <= floor) {
      throw new CfApiError(
        "rate_limited",
        null,
        endpoint,
        [],
        row.reset_at - now,
        `${endpoint} skipped: ${row.remaining} Cloudflare API calls left, ${priority} work needs more than ${floor}`,
      );
    }
  }

  /** Records what a response said about the budget. */
  observe(headers: Headers, status: number): void {
    const row = this.row ?? { remaining: null, reset_at: null, blocked_until: null };
    this.row = row;
    this.loaded = true;
    const now = this.now();
    const parsed = parseRatelimit(headers.get("ratelimit"));
    if (parsed) {
      row.remaining = parsed.remaining;
      row.reset_at = now + parsed.resetSeconds;
    } else if (row.remaining !== null) {
      row.remaining = Math.max(0, row.remaining - 1);
    }
    if (status === 429) {
      const ra = Number(headers.get("retry-after"));
      row.blocked_until = now + (Number.isFinite(ra) && ra > 0 ? ra : DEFAULT_BLOCK_SECONDS);
      row.remaining = 0;
    }
    this.dirty = true;
  }

  /** Writes the observation once, at the end of the invocation. */
  async flush(): Promise<void> {
    if (!this.dirty || !this.row) return;
    this.dirty = false;
    await this.db
      .prepare("INSERT OR REPLACE INTO cf_api_budget (id, remaining, reset_at, blocked_until, observed_at) VALUES (1, ?, ?, ?, ?)")
      .bind(this.row.remaining, this.row.reset_at, this.row.blocked_until, this.now())
      .run();
  }
}
