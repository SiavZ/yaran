/**
 * The G4 fallback APNs transport: node:http2 with one pooled session per APNs host, for the
 * Node runtime (a Cloudflare Container or any VM) when Worker fetch cannot reach APNs.
 *
 * - A session that errors, closes or receives GOAWAY is dropped and reopened on next use.
 * - Each request has the same 10 s deadline as the fetch transport; a timeout or stream
 *   error throws (the client maps it to unavailable).
 * - `connect` exists for tests (a cleartext mock server); production uses TLS to APNs.
 *
 * <module-headers:begin>
 * Uses:
 * src/apns/transport_http2.ts
 * └── src/apns/transport.ts
 * External: node:http2
 *
 * Used by:
 * src/apns/transport_http2.ts
 * ├── src/runtime/node.ts
 * └── test/helpers/runtimes.ts
 * <module-headers:end>
 */
import { connect as h2connect, type ClientHttp2Session, type IncomingHttpHeaders } from "node:http2";
import { APNS_TIMEOUT_MS, type ApnsTransport } from "./transport.ts";

export interface Http2TransportOptions {
  connect?: (origin: string) => ClientHttp2Session;
}

export function http2Transport(opts: Http2TransportOptions = {}): ApnsTransport & { close(): void } {
  const sessions = new Map<string, ClientHttp2Session>();
  const open = (origin: string): ClientHttp2Session => {
    const existing = sessions.get(origin);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const session = (opts.connect ?? h2connect)(origin);
    const drop = () => {
      if (sessions.get(origin) === session) sessions.delete(origin);
    };
    session.on("error", drop).on("close", drop).on("goaway", drop);
    session.unref();
    sessions.set(origin, session);
    return session;
  };
  return {
    send(req) {
      const url = new URL(req.url);
      return new Promise((resolve, reject) => {
        const stream = open(url.origin).request({ ":method": "POST", ":path": url.pathname, ...req.headers });
        stream.setTimeout(APNS_TIMEOUT_MS, () => stream.close());
        let headers: IncomingHttpHeaders = {};
        const chunks: Buffer[] = [];
        stream.on("response", (h) => {
          headers = h;
        });
        stream.on("data", (c: Buffer) => chunks.push(c));
        stream.on("error", reject);
        stream.on("close", () => {
          const status = Number(headers[":status"] ?? 0);
          if (!status) return reject(new Error("the APNs stream closed without an answer"));
          resolve({ status, header: (n) => (headers[n.toLowerCase()] as string | undefined) ?? null, body: Buffer.concat(chunks).toString("utf8") });
        });
        stream.end(req.body);
      });
    },
    close() {
      for (const s of sessions.values()) s.close();
      sessions.clear();
    },
  };
}
