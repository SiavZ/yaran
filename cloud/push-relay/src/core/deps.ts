/**
 * Everything the runtime-agnostic relay core needs, built once per isolate (Worker) or per
 * process (Node) by the runtime entry, plus the structured logger both runtimes share.
 *
 * - The logger writes one JSON object per line. Call sites pass only outcome fields: never
 *   a token, endpoint, JWT, key or body.
 *
 * <module-headers:begin>
 * Uses:
 * src/core/deps.ts
 * ├── src/apns/client.ts
 * ├── src/apns/jwt.ts
 * ├── src/apns/transport.ts
 * ├── src/core/config.ts
 * ├── src/core/endpoint_codec.ts
 * ├── src/core/limits.ts
 * ├── src/fcm/client.ts
 * └── src/fcm/oauth.ts
 * External: none
 *
 * Used by:
 * src/core/deps.ts
 * ├── src/core/handler.ts
 * ├── src/core/mint.ts
 * ├── src/core/receive.ts
 * ├── src/runtime/node.ts
 * ├── src/runtime/worker.ts
 * └── test/helpers/runtimes.ts
 * <module-headers:end>
 */
import { ApnsClient } from "../apns/client.ts";
import { ProviderTokenCache } from "../apns/jwt.ts";
import type { ApnsTransport } from "../apns/transport.ts";
import { FcmClient } from "../fcm/client.ts";
import { FcmTokenSource } from "../fcm/oauth.ts";
import type { RelayConfig } from "./config.ts";
import { importEndpointKeys, type EndpointKeys } from "./endpoint_codec.ts";
import type { Limiter } from "./limits.ts";

export type RelayLog = (level: "info" | "warn" | "error", event: string, fields?: Record<string, unknown>) => void;

export interface RelayDeps {
  config: RelayConfig;
  keys: EndpointKeys;
  limiters: { mint: Limiter; key: Limiter; device: Limiter };
  apns: ApnsClient;
  /** Null unless the G5 fallback is deployed. */
  fcm: FcmClient | null;
  log: RelayLog;
  /** Unix seconds. */
  now(): number;
}

export const consoleLog: RelayLog = (level, event, fields = {}) => {
  console.log(JSON.stringify({ level, event, service: "yaran-push-relay", ...fields }));
};

/** Wires the core from a parsed config and the runtime's transport, fetch and limiters. */
export async function buildRelayDeps(
  config: RelayConfig,
  rt: { transport: ApnsTransport; fetch: typeof fetch; limiters: RelayDeps["limiters"]; log?: RelayLog; now?: () => number },
): Promise<RelayDeps> {
  return {
    config,
    keys: await importEndpointKeys(config.endpointKeys),
    limiters: rt.limiters,
    apns: new ApnsClient(rt.transport, new ProviderTokenCache(config.apns)),
    fcm: config.fcm ? new FcmClient(config.fcm.projectId, new FcmTokenSource(config.fcm.serviceAccount, rt.fetch), rt.fetch) : null,
    log: rt.log ?? consoleLog,
    now: rt.now ?? (() => Math.floor(Date.now() / 1000)),
  };
}
