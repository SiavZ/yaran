/**
 * Pins the push payload (Design §9): event -> payload with exact bytes, truncation at
 * multi-byte boundaries, the 320-byte cap, topic derivation and the delivery table,
 * device-side parsing, and the relay's APNs/FCM wrapping.
 *
 * <module-headers:begin>
 * Uses:
 * test/push.test.ts
 * ├── src/push/apns.ts
 * ├── src/push/payload.ts
 * ├── src/push/topic.ts
 * ├── src/validate.ts
 * └── test/fixtures.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test)
 * <module-headers:end>
 */
import { describe, expect, it } from "vitest";
import { buildRelayApns, buildRelayFcm } from "../src/push/apns.ts";
import { eventToPayload, parsePushPayload, serializePushPayload, testPayload, truncateUtf8 } from "../src/push/payload.ts";
import { pushDelivery, pushTopic } from "../src/push/topic.ts";
import { validate } from "../src/validate.ts";
import { fixture, utf8 } from "./fixtures.ts";

describe("event to payload", () => {
  const f = fixture("push/payload-events.json");
  for (const c of f.cases) {
    it(c.name, () => {
      const payload = eventToPayload(c.event, c.machine_id);
      expect(payload).toEqual(c.payload);
      const bytes = serializePushPayload(payload);
      expect(new TextDecoder().decode(bytes)).toBe(c.serialized);
      expect(bytes.length).toBe(c.bytes);
      expect(validate("PushPayload", payload).valid).toBe(true);
    });
  }
  for (const c of f.refused) {
    it(c.name, () => {
      expect(() => serializePushPayload(eventToPayload(c.event, c.machine_id))).toThrow(/320-byte cap/);
    });
  }
  it("builds the test payload", () => {
    expect(serializePushPayload(testPayload(1731571200))).toEqual(utf8('{"v":1,"k":"test","ts":1731571200}'));
  });
});

describe("truncation", () => {
  for (const c of fixture("push/payload-truncation.json").cases) {
    it(JSON.stringify(c.input), () => {
      const out = truncateUtf8(c.input);
      expect(out).toBe(c.output);
      expect(utf8(out).length).toBe(c.output_bytes);
    });
  }
});

describe("topic and delivery", () => {
  const f = fixture("push/payload-topic.json");
  for (const t of f.topics) {
    it(`topic for ${t.a.slice(0, 12)} ${t.t ?? "(slot)"}`, async () => {
      expect(await pushTopic(t.m, t.a, t.t ?? undefined)).toBe(t.topic);
    });
  }
  for (const d of f.delivery) {
    it(`delivery for ${d.k}`, () => {
      expect(pushDelivery(d.k, f.ttl_setting)).toEqual({ urgency: d.urgency, ttl: d.ttl, topic: d.topic, visible: d.visible });
    });
  }
});

describe("device-side parse", () => {
  for (const c of fixture("push/payload-parse.json").cases) {
    it(c.name, () => {
      const result = parsePushPayload(utf8(c.utf8));
      expect(result.ok ? "ok" : result.code).toBe(c.expect);
    });
  }
});

describe("relay wrapping", () => {
  const f = fixture("push/relay-wrapping.json");
  for (const c of f.apns) {
    it(`APNs: ${c.name}`, () => {
      const out = buildRelayApns({ urgency: c.urgency, topic: c.topic, ttl: c.ttl, registrationId: f.registration_id, body: f.body_b64url, appId: f.app_id, now: f.now });
      expect(out).toEqual({ headers: c.headers, payload: c.payload });
      const type = c.headers["apns-push-type"] === "alert" ? "RelayApnsAlert" : "RelayApnsBackground";
      expect(validate(type, out.payload).valid).toBe(true);
    });
  }
  for (const c of f.fcm) {
    it(`FCM: ${c.name}`, () => {
      const out = buildRelayFcm({ urgency: c.urgency, topic: c.topic, ttl: c.ttl, registrationId: f.registration_id, body: f.body_b64url });
      expect(out).toEqual(c.message);
      expect(validate("RelayFcmMessage", out).valid).toBe(true);
    });
  }
});
