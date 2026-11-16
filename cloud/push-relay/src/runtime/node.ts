/**
 * The relay's Node runtime (G4 fallback): the same core behind node:http, with the
 * node:http2 APNs transport and in-process rate limits, run by container/Dockerfile on
 * Cloudflare Containers (the Worker forwards /w/* to it) or on any VM behind the same DNS
 * name, so endpoints and apps do not change.
 *
 * - Single instance by design: the limiters are per process.
 * - Limits are configurable: RL_MINT_PER_MIN (default 10), RL_KEY_PER_MIN (600),
 *   RL_DEVICE_PER_MIN (60). PORT (default 8080) and HOST (default 0.0.0.0) pick the listener.
 * - Request bodies are buffered to at most 64 KiB before the core's own caps apply.
 *
 * <module-headers:begin>
 * Uses:
 * src/runtime/node.ts
 * ├── src/apns/transport.ts
 * ├── src/apns/transport_http2.ts
 * ├── src/core/config.ts
 * ├── src/core/deps.ts
 * ├── src/core/handler.ts
 * ├── src/core/http.ts
 * └── src/core/limits.ts
 * External: node:http, node:net, node:url
 *
 * Used by: entry point (node src/runtime/node.ts, the G4 fallback runtime run by cloud/push-relay/container/Dockerfile; also started by test/helpers/runtimes.ts)
 * src/runtime/node.ts
 * └── test/helpers/runtimes.ts
 * <module-headers:end>
 */
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import { http2Transport } from "../apns/transport_http2.ts";
import type { ApnsTransport } from "../apns/transport.ts";
import { parseConfig, type EnvLike } from "../core/config.ts";
import { buildRelayDeps } from "../core/deps.ts";
import { createRelay } from "../core/handler.ts";
import { fail } from "../core/http.ts";
import { memoryLimiter } from "../core/limits.ts";

const NODE_MAX_BODY = 64 * 1024;

export interface NodeRelayOptions {
  env: EnvLike;
  port?: number;
  host?: string;
  transport?: ApnsTransport;
  fetch?: typeof fetch;
  now?: () => number;
}

const perMin = (env: EnvLike, name: string, fallback: number) => {
  const n = Number(env[name] ?? fallback);
  if (!Number.isInteger(n) || n < 1) throw new Error(`relay setting ${name} must be a positive integer`);
  return n;
};

async function toRequest(req: IncomingMessage, base: string): Promise<Request | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > NODE_MAX_BODY) return null;
    chunks.push(chunk);
  }
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(new URL(req.url ?? "/", base), { method: req.method, headers, body: hasBody ? Buffer.concat(chunks) : undefined });
}

export async function startNodeRelay(opts: NodeRelayOptions): Promise<{ url: string; close(): Promise<void> }> {
  const transport = opts.transport ?? http2Transport();
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const deps = await buildRelayDeps(parseConfig(opts.env), {
    transport,
    fetch: opts.fetch ?? fetch,
    now,
    limiters: {
      mint: memoryLimiter(perMin(opts.env, "RL_MINT_PER_MIN", 10), 60, now),
      key: memoryLimiter(perMin(opts.env, "RL_KEY_PER_MIN", 600), 60, now),
      device: memoryLimiter(perMin(opts.env, "RL_DEVICE_PER_MIN", 60), 60, now),
    },
  });
  const handler = createRelay(deps);
  const server = createServer(async (req, res) => {
    const request = await toRequest(req, "http://relay.local");
    const response = request ? await handler(request, req.socket.remoteAddress ?? null) : fail("payload_too_large", "The request body is too large.", crypto.randomUUID());
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        if ("close" in transport && typeof transport.close === "function") transport.close();
        server.close(() => resolve());
      }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { url } = await startNodeRelay({ env: process.env, port: Number(process.env.PORT ?? 8080), host: process.env.HOST ?? "0.0.0.0" });
  console.log(JSON.stringify({ level: "info", event: "relay.listening", service: "yaran-push-relay", url }));
}
