/**
 * W6 events intake and W15 test push: validation, dedupe, the push switch, 02's mute rule,
 * relay rules, the detail backstop, rate limiting, Topic and Urgency, and queue failure.
 *
 * <module-headers:begin>
 * Uses:
 * test/push/events_route.test.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/push/events_route.ts
 * ├── src/push/test_route.ts
 * └── test/push/helpers/fakes.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test in cloud/worker (workerd, or Node for test/provisioning))
 * <module-headers:end>
 */
import type { Event } from "@yaran/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { handleEvents } from "../../src/push/events_route.ts";
import { handleTestPush } from "../../src/push/test_route.ts";
import { fixture, harness, MACHINE, muteMachine, NOW, OTHER_USER, OWNER, seedDevice, seedUser, settingsWith, type Harness } from "./helpers/fakes.ts";

const machine = { id: MACHINE, ownerUserId: OWNER };
const RELAY = `https://relay.example.com/w/v1.k1.${"A".repeat(40)}`;
const topics = fixture("push/payload-topic.json").topics as { m: string; a: string; t: string | null; topic: string }[];
const slot = topics.find((t) => t.m === MACHINE && t.t === null && t.a.length === 36)!;
const tab = topics.find((t) => t.m === MACHINE && t.t !== null)!;

let n = 0;
const ev = (over: Partial<Event> = {}): Event =>
  ({ id: `0b8e4c1d-2f3a-4b5c-9d6e-${(++n).toString(16).padStart(12, "0")}`, kind: "attention_raised", ts: "2024-11-14T08:00:00Z", agent_id: slot.a, state: "needs_attention", project: "yaran", label: "fix the tests", ...over }) as Event;

let db: D1Database;
let h: Harness;
beforeEach(async () => {
  h = await harness();
  db = h.db;
  await seedUser(db, OWNER);
  await seedUser(db, OTHER_USER);
});

const post = (events: Event[]) => handleEvents(h.deps, machine, { events });
const accepted = (r: Awaited<ReturnType<typeof post>>) => (r.kind === "json" ? (r.body as { accepted: string[] }) : null);

describe("W6 intake", () => {
  it("queues one push per eligible device with 02's Topic and Urgency", async () => {
    await seedDevice(h, { id: "d-up" });
    await seedDevice(h, { id: "d-ios", channel: "apns_relay", endpoint: RELAY });
    const raised = ev();
    const cleared = ev({ kind: "attention_cleared", state: "idle", tab_id: tab.t! });
    const r = await post([raised, cleared]);
    expect(r).toEqual({ kind: "json", status: 202, body: { accepted: [raised.id, cleared.id], duplicates: [], push_enabled: true } });
    expect(h.queued).toHaveLength(4);
    const forRaise = h.queued.filter((j) => j.payload.k === "attention_raised");
    expect(forRaise.map((j) => j.device_id).sort()).toEqual(["d-ios", "d-up"]);
    expect(forRaise[0]).toMatchObject({ urgency: "high", topic: slot.topic, ttl: 3600, enqueued_at: NOW });
    expect(forRaise[0]!.payload).toEqual({ v: 1, k: "attention_raised", m: MACHINE, a: slot.a, s: "needs_attention", p: "yaran", l: "fix the tests", ts: 1731571200 });
    expect(h.queued.find((j) => j.payload.k === "attention_cleared")).toMatchObject({ urgency: "very-low", topic: tab.topic });
    const stats = await db.prepare("SELECT accepted FROM push_stats").first<{ accepted: number }>();
    expect(stats?.accepted).toBe(4);
  });

  it("answers 202 with the ids when the owner has no devices", async () => {
    const e = ev();
    expect(accepted(await post([e]))?.accepted).toEqual([e.id]);
    expect(h.queued).toHaveLength(0);
  });

  it("lands a repeated event id in duplicates and queues nothing for it", async () => {
    await seedDevice(h, { id: "d-up" });
    const e = ev();
    await post([e]);
    h.queued.length = 0;
    expect(await post([e])).toEqual({ kind: "json", status: 202, body: { accepted: [], duplicates: [e.id], push_enabled: true } });
    expect(h.queued).toHaveLength(0);
  });

  it("with push off answers push_enabled false and queues nothing", async () => {
    await seedDevice(h, { id: "d-up" });
    await h.setPush(settingsWith({ enabled: false }));
    const e = ev();
    expect(await post([e])).toEqual({ kind: "json", status: 202, body: { accepted: [e.id], duplicates: [], push_enabled: false } });
    expect(h.queued).toHaveLength(0);
  });

  it("honours mute_all, an unexpired muted_until and a muted machine, and not an expired muted_until", async () => {
    await seedDevice(h, { id: "d-all", muteAll: true });
    await seedDevice(h, { id: "d-until", mutedUntil: NOW + 60 });
    await seedDevice(h, { id: "d-expired", mutedUntil: NOW });
    await seedDevice(h, { id: "d-machine" });
    await muteMachine(db, "d-machine", MACHINE);
    await seedDevice(h, { id: "d-other-machine" });
    await muteMachine(db, "d-other-machine", "7f1c2a9e-3b4d-4e5f-8a7b-9c0d1e2f3a4b");
    await post([ev()]);
    expect(h.queued.map((j) => j.device_id).sort()).toEqual(["d-expired", "d-other-machine"]);
  });

  it("skips gone, auth_failed, revoked and other users' devices", async () => {
    await seedDevice(h, { id: "d-gone", state: "gone" });
    await seedDevice(h, { id: "d-auth", state: "auth_failed" });
    await seedDevice(h, { id: "d-revoked", revoked: true });
    await seedDevice(h, { id: "d-theirs", userId: OTHER_USER });
    await seedDevice(h, { id: "d-failing", state: "failing" });
    await post([ev()]);
    expect(h.queued.map((j) => j.device_id)).toEqual(["d-failing"]);
  });

  it("skips relay devices while relays are disallowed or not allowlisted", async () => {
    await seedDevice(h, { id: "d-up" });
    await seedDevice(h, { id: "d-ios", channel: "apns_relay", endpoint: RELAY });
    await h.setPush(settingsWith({ relay_allowed: false }));
    await post([ev()]);
    expect(h.queued.map((j) => j.device_id)).toEqual(["d-up"]);
    h.queued.length = 0;
    await h.setPush(settingsWith({ allowed_relays: ["https://relay.other.com"] }));
    await post([ev()]);
    expect(h.queued.map((j) => j.device_id)).toEqual(["d-up"]);
  });

  it("strips p and l when detail is minimal", async () => {
    await seedDevice(h, { id: "d-up" });
    await h.setPush(settingsWith({ detail: "minimal" }));
    await post([ev()]);
    expect(h.queued[0]!.payload).not.toHaveProperty("p");
    expect(h.queued[0]!.payload).not.toHaveProperty("l");
  });

  it("answers 429 with Retry-After when the machine is over its rate", async () => {
    h.limiterOk.value = false;
    expect(await post([ev()])).toMatchObject({ kind: "error", code: "rate_limited", retryAfter: 60 });
  });

  it("refuses a 17-event batch and a malformed event", async () => {
    const big = Array.from({ length: 17 }, () => ev());
    expect(await post(big)).toMatchObject({ kind: "error", code: "validation_failed" });
    expect(await handleEvents(h.deps, machine, { events: [{ id: "nope" }] })).toMatchObject({ kind: "error", code: "validation_failed" });
    expect(await handleEvents(h.deps, machine, null)).toMatchObject({ kind: "error", code: "validation_failed" });
  });

  it("releases the event ids and answers 503 when the queue refuses, so the retry is not a duplicate", async () => {
    await seedDevice(h, { id: "d-up" });
    h.queueFails.value = true;
    const e = ev();
    expect(await post([e])).toMatchObject({ kind: "error", code: "unavailable" });
    h.queueFails.value = false;
    expect(accepted(await post([e]))?.accepted).toEqual([e.id]);
    expect(h.queued).toHaveLength(1);
  });

  it("drops an event whose payload cannot fit even without p and l, and logs it", async () => {
    await seedDevice(h, { id: "d-up" });
    const long = "x".repeat(128);
    await post([ev({ agent_id: long, tab_id: long }), ev()]);
    expect(h.queued).toHaveLength(1);
    expect(h.logs.find((l) => l.event === "push.payload_oversize")).toBeDefined();
  });
});

describe("W15 test push", () => {
  it("queues a test push for the caller's own device and audits it", async () => {
    await seedDevice(h, { id: "d-up" });
    expect(await handleTestPush(h.deps, OWNER, "d-up")).toEqual({ kind: "empty", status: 202 });
    expect(h.queued).toEqual([{ device_id: "d-up", payload: { v: 1, k: "test", ts: NOW }, urgency: "normal", topic: null, ttl: 300, enqueued_at: NOW }]);
    expect(h.audits).toEqual([{ action: "device.test_push", deviceId: "d-up" }]);
  });
  it("answers 404 for another user's device", async () => {
    await seedDevice(h, { id: "d-theirs", userId: OTHER_USER });
    expect(await handleTestPush(h.deps, OWNER, "d-theirs")).toMatchObject({ kind: "error", code: "not_found" });
    expect(h.queued).toHaveLength(0);
  });
  it("answers 409 push_disabled with push off", async () => {
    await seedDevice(h, { id: "d-up" });
    await h.setPush(settingsWith({ enabled: false }));
    expect(await handleTestPush(h.deps, OWNER, "d-up")).toMatchObject({ kind: "error", code: "push_disabled" });
  });
});
