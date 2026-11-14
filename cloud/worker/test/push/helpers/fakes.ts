/**
 * Fakes for the push module's seams (04's settings, data-key sealing, audit, logger, the
 * queue, the rate limiter and fetch) and seeders for users and devices with real P-256
 * subscription keys, so a captured push can be decrypted with the device's own keys.
 *
 * - "Sealed" values are `sealed:<column>:<device id>:<plaintext>`; opening checks the
 *   column and id the way 04's AAD does, so a value copied into another row fails.
 *
 * <module-headers:begin>
 * Uses:
 * helpers/fakes.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── cloud/worker/src/push/seams.ts
 * ├── cloud/worker/src/push/settings.ts
 * └── helpers/d1.ts
 * External: node:fs
 *
 * Used by:
 * helpers/fakes.ts
 * ├── consumer.test.ts
 * ├── endpoint_policy.test.ts
 * ├── events_route.test.ts
 * └── migration.test.ts
 * <module-headers:end>
 */
import { readFileSync } from "node:fs";
import { b64urlEncode, generateEcdhKeyPair, type EcdhKeyPair, type PushChannel } from "@yaran/protocol";
import type { PushDeps, PushJob, PushSettings, QueueMessage, RateLimiter } from "../../../src/push/seams.ts";
import { DEFAULT_PUSH_SETTINGS } from "../../../src/push/settings.ts";
import type { TestD1 } from "./d1.ts";

export const NOW = 1731571200;
export const OWNER = "a0000000-0000-4000-8000-000000000001";
export const OTHER_USER = "a0000000-0000-4000-8000-000000000002";
export const MACHINE = "6f1c2a9e-3b4d-4e5f-8a7b-9c0d1e2f3a4b";
export const SELF_ORIGIN = "https://cp.example.com";

export function fixture<T = any>(path: string): T {
  return JSON.parse(readFileSync(new URL(`../node_modules/@yaran/protocol/fixtures/${path}`, import.meta.url), "utf8")) as T;
}

export interface LogLine {
  level: "info" | "warn" | "error";
  event: string;
  fields: Record<string, unknown>;
}

export interface FetchCall {
  url: string;
  init: RequestInit;
}

export interface Harness {
  db: TestD1;
  deps: PushDeps & { machineEvents: RateLimiter };
  queued: PushJob[];
  logs: LogLine[];
  audits: { action: string; deviceId: string; detail?: Record<string, unknown> }[];
  fetchCalls: FetchCall[];
  settings: { value: PushSettings | undefined };
  respond: (fn: (call: FetchCall) => Response | Promise<Response>) => void;
  limiterOk: { value: boolean };
  clock: { now: number };
  queueFails: { value: boolean };
}

export function harness(db: TestD1): Harness {
  const vapid = fixture("webpush/vapid-vectors.json");
  const h: Omit<Harness, "deps"> & { responder: (call: FetchCall) => Response | Promise<Response> } = {
    db,
    queued: [],
    logs: [],
    audits: [],
    fetchCalls: [],
    settings: { value: undefined },
    responder: () => new Response(null, { status: 201 }),
    respond: (fn) => {
      h.responder = fn;
    },
    limiterOk: { value: true },
    clock: { now: NOW },
    queueFails: { value: false },
  };
  const log = (level: LogLine["level"]) => (event: string, fields: Record<string, unknown> = {}) => void h.logs.push({ level, event, fields });
  const deps: Harness["deps"] = {
    db,
    queue: {
      sendBatch: async (messages) => {
        if (h.queueFails.value) throw new Error("queue unavailable");
        h.queued.push(...messages.map((m) => m.body));
      },
    },
    log: { info: log("info"), warn: log("warn"), error: log("error") },
    readSettings: async () => h.settings.value,
    openDeviceSecret: async (deviceId, column, sealed) => {
      const prefix = `sealed:${column}:${deviceId}:`;
      if (!sealed.startsWith(prefix)) throw new Error("data-key open failed: AAD mismatch");
      return sealed.slice(prefix.length);
    },
    vapidKey: async () => ({ privateJwk: vapid.vapid_private_jwk, publicKey: vapid.vapid_public_key }),
    selfOrigin: SELF_ORIGIN,
    audit: async (action, deviceId, detail) => void h.audits.push({ action, deviceId, ...(detail ? { detail } : {}) }),
    now: () => h.clock.now,
    fetch: (async (url: string, init: RequestInit) => {
      const call = { url, init };
      h.fetchCalls.push(call);
      return h.responder(call);
    }) as typeof fetch,
    machineEvents: { limit: async () => ({ success: h.limiterOk.value }) },
  };
  return { ...h, deps, settings: h.settings } as Harness;
}

export const settingsWith = (over: Partial<PushSettings>): PushSettings => ({ ...DEFAULT_PUSH_SETTINGS, ...over });

export async function seedUser(db: TestD1, id: string): Promise<void> {
  await db.prepare("INSERT INTO users (id, email, slug, created_at) VALUES (?, ?, ?, ?)").bind(id, `${id}@example.com`, id.slice(-12), NOW).run();
}

export interface SeededDevice {
  id: string;
  endpoint: string;
  ua: EcdhKeyPair;
  auth: Uint8Array;
}

let installs = 0;

/** Inserts a registered device (as 06 would) with fresh subscription keys. */
export async function seedDevice(
  db: TestD1,
  o: { id: string; userId?: string; channel?: PushChannel; endpoint?: string; muteAll?: boolean; mutedUntil?: number | null; state?: string; revoked?: boolean },
): Promise<SeededDevice> {
  const ua = await generateEcdhKeyPair();
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const endpoint = o.endpoint ?? `https://updates.push.example.net/wpush/v2/${o.id}-token`;
  await db
    .prepare(
      `INSERT INTO devices (id, user_id, install_id, platform, flavor, form_factor, push_kind, endpoint_enc, endpoint_host, p256dh, auth_enc,
         device_key, device_key_fingerprint, app_version, label, created_at, revoked_at, push_state, mute_all, muted_until)
       VALUES (?, ?, ?, 'android', 'foss', 'phone', ?, ?, ?, ?, ?, ?, ?, '1.0.0', 'phone', ?, ?, ?, ?, ?)`,
    )
    .bind(
      o.id,
      o.userId ?? OWNER,
      `install-${++installs}`,
      o.channel ?? "unifiedpush",
      `sealed:endpoint_enc:${o.id}:${endpoint}`,
      new URL(endpoint).hostname,
      ua.publicRaw,
      `sealed:auth_enc:${o.id}:${b64urlEncode(auth)}`,
      ua.publicRaw,
      "x".repeat(29),
      NOW,
      o.revoked ? NOW : null,
      o.state ?? "active",
      o.muteAll ?? false,
      o.mutedUntil ?? null,
    )
    .run();
  return { id: o.id, endpoint, ua, auth };
}

export async function muteMachine(db: TestD1, deviceId: string, machineId: string): Promise<void> {
  await db.prepare("INSERT INTO device_machine_mutes (device_id, machine_id) VALUES (?, ?)").bind(deviceId, machineId).run();
}

export interface FakeMessage extends QueueMessage<PushJob> {
  acked: boolean;
  retried: { delaySeconds?: number } | null;
}

export function message(body: PushJob, attempts = 1): FakeMessage {
  const m: FakeMessage = {
    body,
    attempts,
    acked: false,
    retried: null,
    ack: () => void (m.acked = true),
    retry: (o) => void (m.retried = o ?? {}),
  };
  return m;
}

export async function deviceRow(db: TestD1, id: string): Promise<Record<string, unknown>> {
  return (await db.prepare("SELECT * FROM devices WHERE id = ?").bind(id).first())!;
}
