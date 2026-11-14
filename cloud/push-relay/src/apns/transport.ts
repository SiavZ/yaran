/**
 * How the relay reaches APNs: an `ApnsTransport` sends one HTTP/2 POST and returns the
 * status, headers and body. The primary transport is the Worker's fetch, which Cloudflare's
 * proxy upgrades to HTTP/2 against APNs when deployed (UNVERIFIED, gate G4; `wrangler dev`
 * does not); the G4 fallback is transport_http2.ts on node:http2.
 *
 * - A transport throws only for a network failure; every HTTP answer is returned.
 *
 * <module-headers:begin>
 * Uses: none
 * External: none
 *
 * Used by:
 * src/apns/transport.ts
 * ├── src/apns/client.ts
 * ├── src/apns/transport_http2.ts
 * ├── src/core/deps.ts
 * ├── src/runtime/node.ts
 * ├── src/runtime/worker.ts
 * └── test/helpers/env.ts
 * <module-headers:end>
 */
export interface UpstreamRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface UpstreamResponse {
  status: number;
  header(name: string): string | null;
  body: string;
}

export interface ApnsTransport {
  send(req: UpstreamRequest): Promise<UpstreamResponse>;
}

export const APNS_TIMEOUT_MS = 10_000;

export function fetchTransport(fetchFn: typeof fetch = fetch): ApnsTransport {
  return {
    async send(req) {
      const res = await fetchFn(req.url, { method: "POST", headers: req.headers, body: req.body, redirect: "manual", signal: AbortSignal.timeout(APNS_TIMEOUT_MS) });
      return { status: res.status, header: (n) => res.headers.get(n), body: await res.text() };
    },
  };
}
