/**
 * Response helpers shared by the relay's routes: 02's error envelope with a request id,
 * the Yaran-Protocol and Yaran-Request-Id headers on every answer, Retry-After where 02
 * asks for it, and a size-capped body read that never buffers more than the cap.
 *
 * <module-headers:begin>
 * Uses:
 * src/core/http.ts
 * └── @yaran/protocol:src/index.ts
 * External: none
 *
 * Used by:
 * src/core/http.ts
 * ├── src/core/handler.ts
 * ├── src/core/mint.ts
 * ├── src/core/receive.ts
 * ├── src/core/upstream.ts
 * ├── src/runtime/node.ts
 * └── src/runtime/worker.ts
 * <module-headers:end>
 */
import { buildErrorEnvelope, concatBytes, PROTOCOL_MAX, type ErrorCode } from "@yaran/protocol";

export const RETRY_AFTER_S = 60;

function baseHeaders(requestId: string): Headers {
  return new Headers({ "Yaran-Protocol": String(PROTOCOL_MAX), "Yaran-Request-Id": requestId, "Cache-Control": "no-store" });
}

export function json(status: number, body: unknown, requestId: string): Response {
  const headers = baseHeaders(requestId);
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(body), { status, headers });
}

export function empty(status: number, requestId: string): Response {
  return new Response(null, { status, headers: baseHeaders(requestId) });
}

export function fail(code: ErrorCode, message: string, requestId: string, details?: Record<string, unknown>): Response {
  const { status, body } = buildErrorEnvelope(code, message, requestId, details);
  const res = json(status, body, requestId);
  if (status === 429 || status === 503) res.headers.set("Retry-After", String(RETRY_AFTER_S));
  return res;
}

/** Reads at most `cap` bytes; "too_large" as soon as the body exceeds it. */
export async function readCapped(req: Request, cap: number): Promise<Uint8Array | "too_large"> {
  const declared = Number(req.headers.get("Content-Length") ?? "NaN");
  if (declared > cap) return "too_large";
  if (!req.body) return new Uint8Array();
  const parts: Uint8Array[] = [];
  let size = 0;
  const reader = req.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > cap) {
      await reader.cancel();
      return "too_large";
    }
    parts.push(value);
  }
  return concatBytes(...parts);
}
