/**
 * The seams the push module needs from Phase 04 (D1, settings, data-key sealing, audit,
 * logging, rate limiting, router) and from the Cloudflare runtime (Queues), as narrow
 * structural interfaces.
 *
 * Every type here is structurally satisfied by the real thing: `D1Like` by a `D1Database`,
 * `PushQueue` by a `Queue<PushJob>` binding, `QueueMessage` by a Queues `Message`,
 * `RateLimiter` by a Rate Limiting binding. The rest (`PushDeps`) is the adapter 04's
 * wiring builds once per request or batch from its own modules; tests pass fakes.
 *
 * - No runtime code beyond `toBytes`; nothing here touches the network or D1.
 *
 * <module-headers:begin>
 * Uses: none
 * External: @yaran/protocol
 *
 * Used by:
 * cloud/worker/src/push/seams.ts
 * ├── cloud/worker/src/push/consumer.ts
 * ├── cloud/worker/src/push/endpoint_policy.ts
 * ├── cloud/worker/src/push/events_route.ts
 * ├── cloud/worker/src/push/fanout.ts
 * ├── cloud/worker/src/push/index.ts
 * ├── cloud/worker/src/push/send.ts
 * ├── cloud/worker/src/push/settings.ts
 * ├── cloud/worker/src/push/store.ts
 * ├── cloud/worker/src/push/test_route.ts
 * ├── yaran-worker-push-tests:consumer.test.ts
 * ├── yaran-worker-push-tests:helpers/d1.ts
 * └── yaran-worker-push-tests:helpers/fakes.ts
 * <module-headers:end>
 */
import type { ErrorCode, PushPayload, Settings, Urgency } from "@yaran/protocol";

export type PushSettings = Settings["push"];

export interface D1Meta {
  changes: number;
}
export interface D1Result<T> {
  results: T[];
  meta: D1Meta;
}
export interface D1Stmt {
  bind(...values: unknown[]): D1Stmt;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1Result<unknown>>;
}
export interface D1Like {
  prepare(sql: string): D1Stmt;
  batch(statements: D1Stmt[]): Promise<D1Result<unknown>[]>;
}

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

export interface PushQueue {
  sendBatch(messages: { body: PushJob }[]): Promise<unknown>;
}

export interface QueueMessage<T> {
  readonly body: T;
  /** 1 on first delivery. */
  readonly attempts: number;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

/** The registry actions this module records (registry/audit-actions.json). */
export type PushAuditAction = "device.push_gone" | "device.push_auth_failed" | "device.push_failing" | "device.test_push";

/** What 04's wiring hands the push module. */
export interface PushDeps {
  db: D1Like;
  queue: PushQueue;
  log: Logger;
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
