/**
 * The queue consumer against a fake push service: every row of the classification table,
 * Retry-After clamping, TTL expiry, failing after five exhausted pushes, write-only-on-change,
 * re-checks at send, the request's headers and VAPID, a real decrypt with the device's keys,
 * and no secret or plaintext in any log line.
 *
 * <module-headers:begin>
 * Uses:
 * test/push/consumer.test.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/push/consumer.ts
 * ├── src/push/send.ts
 * ├── src/push/store.ts
 * ├── src/push/types.ts
 * └── test/push/helpers/fakes.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test in cloud/worker (workerd, or Node for test/provisioning))
 * <module-headers:end>
 */
import { b64urlDecode, decryptWebPush, parsePushPayload, verifyVapid, type PushPayload } from "@yaran/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { consumePushBatch, MAX_RETRIES } from "../../src/push/consumer.ts";
import { classify, parseRetryAfter, VapidCache } from "../../src/push/send.ts";
import type { PushJob } from "../../src/push/types.ts";
import { markOk } from "../../src/push/store.ts";
import { deviceRow, fixture, harness, MACHINE, message, muteMachine, NOW, OWNER, seedDevice, seedUser, SELF_ORIGIN, settingsWith, type Harness, type SeededDevice } from "./helpers/fakes.ts";

const payload: PushPayload = { v: 1, k: "attention_raised", m: MACHINE, a: "1d2e3f40-5a6b-4c7d-8e9f-0a1b2c3d4e5f", s: "needs_attention", p: "secret-project", l: "secret-label", ts: NOW };
const job = (over: Partial<PushJob> = {}): PushJob => ({ device_id: "d1", payload, urgency: "high", topic: "ymz4wvfQl4P7VBQ1dIz_qZ4g7zOVj7re", ttl: 3600, enqueued_at: NOW, ...over });

let db: D1Database;
let h: Harness;
let dev: SeededDevice;
let consoleSpy: ReturnType<typeof vi.spyOn>[];
beforeEach(async () => {
  h = await harness();
  db = h.db;
  await seedUser(db, OWNER);
  dev = await seedDevice(h, { id: "d1" });
  consoleSpy = (["log", "info", "warn", "error", "debug"] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}));
});
afterEach(() => {
  const printed = JSON.stringify([h.logs, consoleSpy.map((s) => s.mock.calls)]);
  for (const secret of [dev.endpoint, "secret-project", "secret-label", "vapid t=", "wpush/v2"]) expect(printed).not.toContain(secret);
  vi.restoreAllMocks();
});

const run = async (j: PushJob = job(), attempts = 1) => {
  const m = message(j, attempts);
  await consumePushBatch(h.deps, [m], new VapidCache());
  return m;
};

describe("a delivered push", () => {
  it("decrypts on the device, carries 02's headers and a VAPID token for the push origin", async () => {
    const m = await run();
    expect(m.acked).toBe(true);
    const { url, init } = h.fetchCalls[0]!;
    expect(url).toBe(dev.endpoint);
    const headers = init.headers as Record<string, string>;
    expect(headers).toMatchObject({ TTL: "3600", Urgency: "high", Topic: job().topic, "Content-Encoding": "aes128gcm" });
    expect(init.redirect).toBe("manual");
    const plain = await decryptWebPush(init.body as Uint8Array, dev.ua.privateKey, dev.ua.publicRaw, dev.auth);
    expect(parsePushPayload(plain)).toEqual({ ok: true, payload });
    const vapid = fixture("webpush/vapid-vectors.json");
    const verdict = await verifyVapid(headers.Authorization, { boundKey: b64urlDecode(vapid.vapid_public_key)!, audience: "https://updates.push.example.net", now: NOW });
    expect(verdict).toMatchObject({ ok: true, claims: { sub: SELF_ORIGIN, exp: NOW + 12 * 3600 } });
    expect(await deviceRow(db, "d1")).toMatchObject({ push_state: "active", last_push_ok_at: NOW, consecutive_failures: 0 });
    expect((await db.prepare("SELECT delivered FROM push_stats").first<{ delivered: number }>())?.delivered).toBe(1);
  });

  it("sends the remaining TTL on a retry and no Topic for a test push", async () => {
    h.clock.now = NOW + 100;
    await run(job({ payload: { v: 1, k: "test", ts: NOW }, topic: null, ttl: 300, urgency: "normal" }), 2);
    const headers = h.fetchCalls[0]!.init.headers as Record<string, string>;
    expect(headers.TTL).toBe("200");
    expect(headers).not.toHaveProperty("Topic");
  });

  it("writes state only on change and the success time at most hourly", async () => {
    await markOk(db, "d1", NOW);
    expect(await markOk(db, "d1", NOW + 60)).toBe(0);
    expect(await markOk(db, "d1", NOW + 3600)).toBe(1);
    expect((await deviceRow(db, "d1")).last_push_ok_at).toBe(NOW + 3600);
  });
});

describe("classification", () => {
  it.each([
    [404, "gone"],
    [410, "gone"],
  ])("%i clears the subscription, marks gone, keeps the row and audits", async (status) => {
    h.respond(() => new Response(null, { status }));
    const m = await run();
    expect(m.acked).toBe(true);
    expect(await deviceRow(db, "d1")).toMatchObject({ push_state: "gone", endpoint_enc: null, endpoint_host: null, p256dh: null, auth_enc: null, id: "d1", revoked_at: null });
    expect(h.audits).toEqual([{ action: "device.push_gone", deviceId: "d1", detail: { status } }]);
  });

  it.each([401, 403])("%i marks auth_failed and audits", async (status) => {
    h.respond(() => new Response(null, { status }));
    expect((await run()).acked).toBe(true);
    expect((await deviceRow(db, "d1")).push_state).toBe("auth_failed");
    expect(h.audits[0]!.action).toBe("device.push_auth_failed");
  });

  it.each([400, 413, 302])("%i is a bug: acked, logged with a redacted excerpt, never retried", async (status) => {
    h.respond(({ url }) => new Response(`bad request for ${url} at ${new URL(url).pathname}`, { status, headers: status === 302 ? { Location: "https://x.example" } : {} }));
    const m = await run();
    expect(m.acked).toBe(true);
    expect(m.retried).toBeNull();
    const line = h.logs.find((l) => l.event === "push.rejected")!;
    expect(line.fields).toMatchObject({ status, device_id: "d1", push_host: "updates.push.example.net" });
    expect(line.fields.body_excerpt).toBe("bad request for <endpoint> at <endpoint>");
    expect((await deviceRow(db, "d1")).push_state).toBe("active");
  });

  it.each([
    ["Retry-After honoured", "120", 120],
    ["clamped up to 10", "1", 10],
    ["clamped down to 3600", "99999", 3600],
    ["absent means 60", null, 60],
  ])("429: %s", async (_, retryAfter, delay) => {
    h.respond(() => new Response(null, { status: 429, headers: retryAfter ? { "Retry-After": retryAfter } : {} }));
    const m = await run();
    expect(m.retried).toEqual({ delaySeconds: delay });
    expect(m.acked).toBe(false);
  });

  it.each([
    [500, 1, 20],
    [503, 3, 80],
    [502, 7, 900],
  ])("%i on attempt %i retries after %is", async (status, attempts, delay) => {
    h.respond(() => new Response(null, { status }));
    expect((await run(job(), attempts)).retried).toEqual({ delaySeconds: delay });
  });

  it("a network error retries with backoff", async () => {
    h.respond(() => {
      throw new TypeError("network down");
    });
    expect((await run(job(), 2)).retried).toEqual({ delaySeconds: 40 });
  });

  it("parses an HTTP-date Retry-After", () => {
    expect(parseRetryAfter(new Date((NOW + 30) * 1000).toUTCString(), NOW)).toBe(30);
    expect(classify(429, "garbage", 1, NOW)).toEqual({ kind: "retry", status: 429, delaySeconds: 60 });
  });
});

describe("exhaustion", () => {
  it("acks a retry past max_retries and counts it", async () => {
    h.respond(() => new Response(null, { status: 503 }));
    const m = await run(job(), MAX_RETRIES + 1);
    expect(m.acked).toBe(true);
    expect(m.retried).toBeNull();
    expect((await deviceRow(db, "d1")).consecutive_failures).toBe(1);
  });

  it("acks a retry past its TTL without sending", async () => {
    h.clock.now = NOW + 3601;
    const m = await run(job(), 2);
    expect(m.acked).toBe(true);
    expect(h.fetchCalls).toHaveLength(0);
  });

  it("turns the device failing at the fifth exhausted push, audited once, and a success resets it", async () => {
    h.respond(() => new Response(null, { status: 500 }));
    for (let i = 0; i < 6; i++) await run(job(), MAX_RETRIES + 1);
    expect(await deviceRow(db, "d1")).toMatchObject({ push_state: "failing", consecutive_failures: 6 });
    expect(h.audits.filter((a) => a.action === "device.push_failing")).toHaveLength(1);
    h.respond(() => new Response(null, { status: 201 }));
    await run();
    expect(await deviceRow(db, "d1")).toMatchObject({ push_state: "active", consecutive_failures: 0 });
  });
});

describe("re-checks at send", () => {
  it("drops a push to a device muted since fan-out, but not a test push", async () => {
    await muteMachine(db, "d1", MACHINE);
    expect((await run()).acked).toBe(true);
    expect(h.fetchCalls).toHaveLength(0);
    await run(job({ payload: { v: 1, k: "test", ts: NOW }, topic: null }));
    expect(h.fetchCalls).toHaveLength(1);
  });

  it("drops when push was turned off, the device went gone or was revoked", async () => {
    await h.setPush(settingsWith({ enabled: false }));
    await run();
    await h.setPush(undefined);
    await db.prepare("UPDATE devices SET revoked_at = ? WHERE id = 'd1'").bind(NOW).run();
    await run();
    expect(h.fetchCalls).toHaveLength(0);
  });

  it("drops a relay push once relays are disallowed", async () => {
    await seedDevice(h, { id: "d-ios", channel: "apns_relay", endpoint: `https://relay.example.com/w/v1.k1.${"A".repeat(40)}` });
    await h.setPush(settingsWith({ relay_allowed: false }));
    expect((await run(job({ device_id: "d-ios" }))).acked).toBe(true);
    expect(h.fetchCalls).toHaveLength(0);
  });

  it("retries rather than loses a push whose secrets cannot be opened", async () => {
    await db.prepare("UPDATE devices SET auth_enc = 'sealed:auth_enc:other:AAAA' WHERE id = 'd1'").run();
    const m = await run();
    expect(m.retried).toEqual({ delaySeconds: 20 });
  });

  it("batches several devices with one read and sends each", async () => {
    await seedDevice(h, { id: "d2" });
    const ms = [message(job()), message(job({ device_id: "d2" }))];
    await consumePushBatch(h.deps, ms, new VapidCache());
    expect(ms.every((m) => m.acked)).toBe(true);
    expect(h.fetchCalls).toHaveLength(2);
    const auth = h.fetchCalls.map((c) => (c.init.headers as Record<string, string>).Authorization);
    expect(auth[0]).toBe(auth[1]);
  });
});
