/**
 * The push module's own types: the queued job, the dependencies 04's wiring builds
 * (`push/deps.ts`), and a route outcome `push/routes.ts` turns into a response. Bindings
 * are Cloudflare's own types (D1, Queue, Message, RateLimit).
 *
 * <module-headers:begin>
 * Uses:
 * src/push/types.ts
 * ├── @yaran/protocol:src/index.ts
 * └── src/log/logger.ts
 * External: none
 *
 * Used by:
 * src/push/types.ts
 * ├── src/index.ts
 * ├── src/push/consumer.ts
 * ├── src/push/deps.ts
 * ├── src/push/endpoint_policy.ts
 * ├── src/push/events_route.ts
 * ├── src/push/fanout.ts
 * ├── src/push/routes.ts
 * ├── src/push/send.ts
 * ├── src/push/settings.ts
 * ├── src/push/store.ts
 * ├── src/push/test_route.ts
 * ├── test/push/consumer.test.ts
 * └── test/push/helpers/fakes.ts
 * <module-headers:end>
 */
import type { ErrorCode, PushPayload, Settings, Urgency } from "@yaran/protocol";
import type { Logger } from "../log/logger.ts";

export type PushSettings = Settings["push"];

/** One push for one device, the body of a PUSH_QUEUE message. */
export interface PushJob {
  device_id: string;
  payload: PushPayload;
  urgency: Urgency;
  /** 02's topic(m, a, t); null for the test push. */
  topic: string | null;
  ttl: number;
  /** Unix seconds when the event was accepted. */
  enqueued_at: number;
}

/** The queue producer, as far as the module uses it (a `Queue<PushJob>` binding satisfies it). */
export interface PushQueue {
  sendBatch(messages: { body: PushJob }[]): Promise<unknown>;
}
export type QueueMessage<T> = Pick<Message<T>, "body" | "attempts" | "ack" | "retry">;
export type RateLimiter = Pick<RateLimit, "limit">;

/** The registry actions this module records (registry/audit-actions.json). */
export type PushAuditAction = "device.push_gone" | "device.push_auth_failed" | "device.push_failing" | "device.test_push";

/** What 04's wiring hands the push module. */
export interface PushDeps {
  db: D1Database;
  queue: PushQueue;
  log: Pick<Logger, "info" | "warn" | "error">;
  /** 04's validated `push` settings row; undefined when never written (defaults apply). */
  readSettings(): Promise<unknown>;
  /** 04's data-key open for a sealed `devices` column, AAD `devices.<column>:<device id>`; UTF-8 text. */
  openDeviceSecret(deviceId: string, column: "endpoint_enc" | "auth_enc", sealed: string): Promise<string>;
  /** The org VAPID key: 07's sealed private JWK, opened, and its public point (base64url). */
  vapidKey(): Promise<{ privateJwk: JsonWebKey; publicKey: string }>;
  /** The Worker's own https origin, used as the VAPID `sub` (no admin email leaves the org). */
  selfOrigin: string;
  audit(action: PushAuditAction, deviceId: string, detail?: Record<string, unknown>): Promise<void>;
  /** Unix seconds. */
  now(): number;
  fetch?: typeof fetch;
}

/** A route's answer; 04's pipeline renders `error` as 02's envelope with its request id. */
export type RouteResult =
  | { kind: "json"; status: number; body: unknown }
  | { kind: "empty"; status: number }
  | { kind: "error"; code: ErrorCode; message: string; details?: Record<string, unknown>; retryAfter?: number };

/** D1 returns BLOBs as number arrays, ArrayBuffers or Uint8Arrays depending on the driver. */
export function toBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  return null;
}
