/**
 * The relay's Cloudflare Worker entry (primary runtime): builds the core once per isolate
 * from the Worker's vars, secrets and Rate Limiting bindings, and serves every request.
 *
 * - The client IP for mint limiting is CF-Connecting-IP.
 * - A missing or malformed setting answers 503 unavailable and logs the setting's name,
 *   never its value.
 *
 * <module-headers:begin>
 * Uses:
 * src/runtime/worker.ts
 * ├── src/apns/transport.ts
 * ├── src/core/config.ts
 * ├── src/core/deps.ts
 * ├── src/core/handler.ts
 * ├── src/core/http.ts
 * └── src/core/limits.ts
 * External: none
 *
 * Used by: entry point (Cloudflare Worker entry of the publisher push relay (cloud/push-relay/wrangler.jsonc main))
 * <module-headers:end>
 */
import { fetchTransport } from "../apns/transport.ts";
import { parseConfig } from "../core/config.ts";
import { buildRelayDeps, consoleLog } from "../core/deps.ts";
import { createRelay, type RelayHandler } from "../core/handler.ts";
import { fail } from "../core/http.ts";
import { bindingLimiter, type RateLimitBinding } from "../core/limits.ts";

export interface Env {
  MINT_RL: RateLimitBinding;
  KEY_RL: RateLimitBinding;
  DEVICE_RL: RateLimitBinding;
  [setting: string]: unknown;
}

let built: { env: Env; handler: Promise<RelayHandler> } | null = null;

async function build(env: Env): Promise<RelayHandler> {
  try {
    const deps = await buildRelayDeps(parseConfig(env), {
      transport: fetchTransport(),
      fetch: (input, init) => fetch(input, init),
      limiters: { mint: bindingLimiter(env.MINT_RL), key: bindingLimiter(env.KEY_RL), device: bindingLimiter(env.DEVICE_RL) },
    });
    return createRelay(deps);
  } catch (err) {
    const reason = err instanceof Error ? err.message : "unknown";
    return async () => {
      consoleLog("error", "relay.misconfigured", { reason });
      return fail("unavailable", "The relay is not configured; the publisher has been alerted.", crypto.randomUUID());
    };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (built?.env !== env) built = { env, handler: build(env) };
    return (await built.handler)(request, request.headers.get("CF-Connecting-IP"));
  },
};
