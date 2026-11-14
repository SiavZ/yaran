/**
 * A cron-style AppContext over the test env, for exercising modules outside the pipeline.
 *
 * <module-headers:begin>
 * Uses:
 * test/helpers/app.ts
 * ├── src/http/context.ts
 * ├── src/log/logger.ts
 * └── test/helpers/seed.ts
 * External: cloudflare:test
 *
 * Used by:
 * test/helpers/app.ts
 * ├── test/audit.test.ts
 * ├── test/data-key.test.ts
 * ├── test/no-secret-leak.test.ts
 * ├── test/prov-context.test.ts
 * ├── test/purge.test.ts
 * └── test/rate-limit.test.ts
 * <module-headers:end>
 */
import { env } from "cloudflare:test";
import type { AppContext } from "../../src/http/context.ts";
import { createLogger } from "../../src/log/logger.ts";
import { NOW } from "./seed.ts";

export function appCtx(patch: Partial<Cloudflare.Env> = {}, now = NOW): AppContext {
  return {
    env: { ...env, ...patch } as Cloudflare.Env, db: env.DB, log: createLogger(), now: () => now, requestId: "test",
    ip: "198.51.100.7", country: "SE", actor: () => ({ kind: "system" }), waitUntil: () => {},
  };
}

/** base64 of 32 random bytes: a fresh DATA_KEY. */
export const freshDataKey = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
