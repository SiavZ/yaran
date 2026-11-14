/**
 * What a delivery attempt to APNs or FCM came to, as one exhaustive union, and how each
 * verdict answers the org Worker (02 error codes, mapped back by 08's classification table).
 *
 * - delivered → 201; gone → 410 push_endpoint_gone (the org clears the subscription);
 *   bad_request → 400; too_large → 413; rate_limited → 429 + Retry-After;
 *   misconfigured (provider credentials) → 502 relay_upstream_failed; unavailable → 503.
 *
 * <module-headers:begin>
 * Uses:
 * src/core/upstream.ts
 * └── src/core/http.ts
 * External: none
 *
 * Used by:
 * src/core/upstream.ts
 * ├── src/apns/client.ts
 * ├── src/core/receive.ts
 * └── src/fcm/client.ts
 * <module-headers:end>
 */
import { empty, fail } from "./http.ts";

export type UpstreamVerdict =
  | { kind: "delivered"; status: number }
  | { kind: "gone"; status: number; reason: string }
  | { kind: "bad_request"; status: number; reason: string }
  | { kind: "too_large"; status: number }
  | { kind: "rate_limited"; status: number }
  | { kind: "misconfigured"; status: number; reason: string }
  | { kind: "unavailable"; status: number; reason: string };

export function verdictResponse(v: UpstreamVerdict, requestId: string): Response {
  switch (v.kind) {
    case "delivered":
      return empty(201, requestId);
    case "gone":
      return fail("push_endpoint_gone", "The device token is no longer valid; register the device again.", requestId);
    case "bad_request":
      return fail("bad_request", "The push service refused the message.", requestId);
    case "too_large":
      return fail("payload_too_large", "The message is too large for the push service.", requestId);
    case "rate_limited":
      return fail("rate_limited", "The push service is throttling this device; retry later.", requestId);
    case "misconfigured":
      return fail("relay_upstream_failed", "The relay's push credentials were refused; the publisher has been alerted.", requestId);
    case "unavailable":
      return fail("unavailable", "The push service is unavailable; retry later.", requestId);
    default:
      return assertNever(v);
  }
}

export function assertNever(value: never): never {
  throw new Error(`unhandled value ${JSON.stringify(value)}`);
}

/** The APNs/FCM `reason` field of an error body, sanitized to a short token. */
export function upstreamReason(body: string): string {
  try {
    const v = JSON.parse(body) as { reason?: unknown; error?: { status?: unknown } };
    const r = typeof v.reason === "string" ? v.reason : typeof v.error?.status === "string" ? v.error.status : "";
    return r.replace(/[^A-Za-z0-9_]/g, "").slice(0, 64) || "unknown";
  } catch {
    return "unknown";
  }
}
