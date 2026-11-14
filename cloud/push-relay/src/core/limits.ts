/**
 * Rate limiting behind one `Limiter` interface: the Cloudflare Rate Limiting binding in the
 * Worker runtime, an in-process fixed-window counter in the Node runtime.
 *
 * Keys are a client IP (mint), SHA-256 of an org's VAPID key, and SHA-256 of a device token,
 * so the binding never sees a token. The binding is per location and permissive; the Node
 * counter is per process (the fallback runs one instance, stated in its runtime file).
 *
 * <module-headers:begin>
 * Uses: none
 * External: none
 *
 * Used by:
 * src/core/limits.ts
 * ├── src/core/deps.ts
 * ├── src/runtime/node.ts
 * ├── src/runtime/worker.ts
 * └── test/helpers/runtimes.ts
 * <module-headers:end>
 */
export interface Limiter {
  /** True while the key is under its limit. */
  allow(key: string): Promise<boolean>;
}

/** A Workers Rate Limiting binding. */
export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export function bindingLimiter(binding: RateLimitBinding): Limiter {
  return { allow: async (key) => (await binding.limit({ key })).success };
}

/** Fixed-window counter: at most `limit` calls per key per `periodS` seconds. */
export function memoryLimiter(limit: number, periodS: number, now: () => number = () => Date.now() / 1000): Limiter {
  const windows = new Map<string, { start: number; count: number }>();
  return {
    async allow(key) {
      const t = now();
      const w = windows.get(key);
      if (!w || t - w.start >= periodS) {
        if (windows.size > 50_000) windows.clear(); // bound memory under a key flood
        windows.set(key, { start: t, count: 1 });
        return limit >= 1;
      }
      w.count++;
      return w.count <= limit;
    },
  };
}
