/**
 * The push test harness: the real `PushDeps` (04's D1, data key, settings and audit
 * writer, 07's sealed VAPID key) over the test database, with the queue, the per-machine
 * limiter and the push services' `fetch` faked, and seeders for users and devices with
 * real P-256 subscription keys, so a captured push can be decrypted with the device's keys.
 *
 * - Device endpoints and auth secrets are sealed with 04's data key under their row's AAD.
 * - `audits` records what the module audited (a spy over the real writer); `logs` is the
 *   logger the module was handed.
 *
 * <module-headers:begin>
 * Uses:
 * test/push/helpers/fakes.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── cloud/protocol/fixtures/push/payload-topic.json
 * ├── cloud/protocol/fixtures/webpush/vapid-vectors.json
 * ├── src/db/settings.ts
 * ├── src/http/context.ts
 * ├── src/log/logger.ts
 * ├── src/push/deps.ts
 * ├── src/push/settings.ts
 * ├── src/push/types.ts
 * ├── src/security/data-key.ts
 * ├── src/setup/steps/keys.ts
 * └── test/helpers/deps.ts
 * External: cloudflare:test
 *
 * Used by:
 * test/push/helpers/fakes.ts
 * ├── test/push/consumer.test.ts
 * ├── test/push/endpoint_policy.test.ts
 * ├── test/push/events_route.test.ts
 * ├── test/push/migration.test.ts
 * └── test/push/routes.test.ts
 * <module-headers:end>
 */
import topicFixture from "@yaran/protocol/fixtures/push/payload-topic.json" with { type: "json" };
import vapidFixture from "@yaran/protocol/fixtures/webpush/vapid-vectors.json" with { type: "json" };
import { b64urlEncode, generateEcdhKeyPair, type EcdhKeyPair, type PushChannel } from "@yaran/protocol";
import { env } from "cloudflare:test";
import { setSetting } from "../../../src/db/settings.ts";
import type { AppContext } from "../../../src/http/context.ts";
import type { Logger } from "../../../src/log/logger.ts";
import { pushDeps } from "../../../src/push/deps.ts";
import { DEFAULT_PUSH_SETTINGS } from "../../../src/push/settings.ts";
import type { PushDeps, PushJob, PushSettings, QueueMessage, RateLimiter } from "../../../src/push/types.ts";
import { seal } from "../../../src/security/data-key.ts";
import { VAPID_AAD } from "../../../src/setup/steps/keys.ts";
import { wipe } from "../../helpers/deps.ts";

export const NOW = 1731571200;
export const OWNER = "a0000000-0000-4000-8000-000000000001";
export const OTHER_USER = "a0000000-0000-4000-8000-000000000002";
export const MACHINE = "6f1c2a9e-3b4d-4e5f-8a7b-9c0d1e2f3a4b";
export const SELF_ORIGIN = "https://cp.example.com";

const FIXTURES: Record<string, unknown> = { "push/payload-topic.json": topicFixture, "webpush/vapid-vectors.json": vapidFixture };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function fixture<T = any>(path: string): T {
  const f = FIXTURES[path];
  if (f === undefined) throw new Error(`no fixture ${path} in the push harness`);
  return f as T;
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
  db: D1Database;
  app: AppContext;
  deps: PushDeps & { machineEvents: RateLimiter };
  queued: PushJob[];
  logs: LogLine[];
  audits: { action: string; deviceId: string; detail?: Record<string, unknown> }[];
  fetchCalls: FetchCall[];
  respond: (fn: (call: FetchCall) => Response | Promise<Response>) => void;
  limiterOk: { value: boolean };
  clock: { now: number };
  queueFails: { value: boolean };
  /** Stores the org's `push` settings row; undefined removes it (defaults apply). */
  setPush(value: PushSettings | undefined): Promise<void>;
}

/** A fresh database, the org's control-plane host and 07's VAPID key, and the real deps. */
export async function harness(): Promise<Harness> {
  await wipe();
  const vapid = fixture("webpush/vapid-vectors.json");
  const logs: LogLine[] = [];
  const line = (level: LogLine["level"]) => (event: string, fields: Record<string, unknown> = {}) => void logs.push({ level, event, fields });
  const log: Logger = { debug: () => {}, info: line("info"), warn: line("warn"), error: line("error"), with: () => log };
  const clock = { now: NOW };
  const app: AppContext = {
    env, db: env.DB, log, now: () => clock.now, requestId: "req-push", ip: null, country: null, actor: () => ({ kind: "system" }), waitUntil: () => {},
  };
  await setSetting(env.DB, "control_plane_host", new URL(SELF_ORIGIN).hostname, "test", NOW);
  await setSetting(env.DB, "vapid_public_key", vapid.vapid_public_key, "test", NOW);
  await setSetting(env.DB, "vapid_private_key_enc", await seal(app, "vapid", VAPID_AAD, JSON.stringify(vapid.vapid_private_jwk)), "test", NOW);
  let responder: (call: FetchCall) => Response | Promise<Response> = () => new Response(null, { status: 201 });
  const h = {
    db: env.DB,
    app,
    queued: [] as PushJob[],
    logs,
    audits: [] as Harness["audits"],
    fetchCalls: [] as FetchCall[],
    respond: (fn: typeof responder) => void (responder = fn),
    limiterOk: { value: true },
    clock,
    queueFails: { value: false },
    setPush: async (value: PushSettings | undefined) => {
      if (value === undefined) await env.DB.prepare("DELETE FROM settings WHERE key = 'push'").run();
      else await setSetting(env.DB, "push", value, "test", NOW);
    },
  };
  const real = await pushDeps(app, {
    queue: {
      sendBatch: async (messages) => {
        if (h.queueFails.value) throw new Error("queue unavailable");
        for (const m of messages) h.queued.push(m.body);
      },
    },
    fetch: (async (url: string, init: RequestInit) => {
      const call = { url, init };
      h.fetchCalls.push(call);
      return responder(call);
    }) as typeof fetch,
  });
  const deps: Harness["deps"] = {
    ...real,
    audit: async (action, deviceId, detail) => {
      await real.audit(action, deviceId, detail);
      h.audits.push({ action, deviceId, ...(detail ? { detail } : {}) });
    },
    machineEvents: { limit: async () => ({ success: h.limiterOk.value }) },
  };
  return { ...h, deps };
}

export const settingsWith = (over: Partial<PushSettings>): PushSettings => ({ ...DEFAULT_PUSH_SETTINGS, ...over });

export async function seedUser(db: D1Database, id: string): Promise<void> {
  await db.prepare("INSERT INTO users (id, email, slug, created_at) VALUES (?, ?, ?, ?)").bind(id, `${id}@example.com`, id.slice(-12), NOW).run();
}

export interface SeededDevice {
  id: string;
  endpoint: string;
  ua: EcdhKeyPair;
  auth: Uint8Array;
}

let installs = 0;

/** Inserts a registered device (as 06 would) with fresh subscription keys, sealed by 04's data key. */
export async function seedDevice(
  h: Harness,
  o: { id: string; userId?: string; channel?: PushChannel; endpoint?: string; muteAll?: boolean; mutedUntil?: number | null; state?: string; revoked?: boolean },
): Promise<SeededDevice> {
  const ua = await generateEcdhKeyPair();
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const endpoint = o.endpoint ?? `https://updates.push.example.net/wpush/v2/${o.id}-token`;
  const sealed = (column: "endpoint_enc" | "auth_enc", text: string) =>
    seal(h.app, column === "endpoint_enc" ? "device_endpoint" : "device_auth", { table: "devices", column, rowId: o.id }, text);
  await h.db
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
      await sealed("endpoint_enc", endpoint),
      new URL(endpoint).hostname,
      ua.publicRaw,
      await sealed("auth_enc", b64urlEncode(auth)),
      ua.publicRaw,
      "x".repeat(29),
      NOW,
      o.revoked ? NOW : null,
      o.state ?? "active",
      o.muteAll ? 1 : 0,
      o.mutedUntil ?? null,
    )
    .run();
  return { id: o.id, endpoint, ua, auth };
}

export async function muteMachine(db: D1Database, deviceId: string, machineId: string): Promise<void> {
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

export async function deviceRow(db: D1Database, id: string): Promise<Record<string, unknown>> {
  return (await db.prepare("SELECT * FROM devices WHERE id = ?").bind(id).first())!;
}
