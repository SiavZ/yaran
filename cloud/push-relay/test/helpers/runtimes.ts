/**
 * The two ways the core relay suite runs: "core" calls the runtime-agnostic handler with the
 * in-process mock APNs transport; "node" starts the Node runtime on a real port with the
 * node:http2 transport pointed at the mock APNs server. Both share the mock Google fetch and
 * a fixed clock, and both log through console.log, which the suite captures.
 *
 * <module-headers:begin>
 * Uses:
 * test/helpers/runtimes.ts
 * ├── src/apns/transport_http2.ts
 * ├── src/core/config.ts
 * ├── src/core/deps.ts
 * ├── src/core/handler.ts
 * ├── src/core/limits.ts
 * ├── src/runtime/node.ts
 * └── test/helpers/env.ts
 * External: node:http2
 *
 * Used by:
 * test/helpers/runtimes.ts
 * └── test/relay.test.ts
 * <module-headers:end>
 */
import { connect } from "node:http2";
import { http2Transport } from "../../src/apns/transport_http2.ts";
import { parseConfig } from "../../src/core/config.ts";
import { buildRelayDeps } from "../../src/core/deps.ts";
import { createRelay } from "../../src/core/handler.ts";
import { memoryLimiter } from "../../src/core/limits.ts";
import { startNodeRelay } from "../../src/runtime/node.ts";
import { credentials, MockApns, MockGoogle, NOW, ORIGIN, type Credentials } from "./env.ts";

export type RuntimeName = "core" | "node";

export interface RelayHarness {
  request(path: string, init?: RequestInit): Promise<Response>;
  apns: MockApns;
  google: MockGoogle;
  creds: Credentials;
  /** The APNs request path as this runtime's mock records it (host only on the core path). */
  apnsPath(env: "production" | "sandbox", token: string): string;
  close(): Promise<void>;
}

export const RUNTIMES: RuntimeName[] = (process.env.RELAY_RUNTIMES ?? "core,node").split(",").map((s) => s.trim() as RuntimeName);

export async function startRelay(name: RuntimeName, envOver: Record<string, string> = {}): Promise<RelayHarness> {
  const creds = await credentials(envOver);
  const apns = new MockApns();
  const google = new MockGoogle();
  const now = () => NOW;
  if (name === "core") {
    const per = (k: string) => Number(creds.env[k]);
    const deps = await buildRelayDeps(parseConfig(creds.env), {
      transport: apns.transport,
      fetch: google.fetch,
      now,
      limiters: { mint: memoryLimiter(per("RL_MINT_PER_MIN"), 60, now), key: memoryLimiter(per("RL_KEY_PER_MIN"), 60, now), device: memoryLimiter(per("RL_DEVICE_PER_MIN"), 60, now) },
    });
    const handler = createRelay(deps);
    const hosts = { production: "api.push.apple.com", sandbox: "api.sandbox.push.apple.com" };
    return {
      request: (path, init) => handler(new Request(`${ORIGIN}${path}`, init), "203.0.113.7"),
      apns,
      google,
      creds,
      apnsPath: (env, token) => `${hosts[env]}/3/device/${token}`,
      close: async () => {},
    };
  }
  const apnsOrigin = await apns.listen();
  const node = await startNodeRelay({ env: creds.env, transport: http2Transport({ connect: () => connect(apnsOrigin) }), fetch: google.fetch, now });
  return {
    request: (path, init) => fetch(`${node.url}${path}`, init),
    apns,
    google,
    creds,
    apnsPath: (_env, token) => `/3/device/${token}`,
    close: async () => {
      await node.close();
      await apns.close();
    },
  };
}
