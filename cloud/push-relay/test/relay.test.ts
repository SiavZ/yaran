/**
 * The relay's core suite, run against the handler and again against the Node runtime:
 * RelayMeta, mint and receive for both channels, every refusal, the APNs request bodies
 * byte-equal to 02's relay-wrapping fixture, every APNs answer mapping, rate limits, and no
 * token, endpoint or JWT in any log line.
 *
 * <module-headers:begin>
 * Uses:
 * test/relay.test.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── test/helpers/env.ts
 * └── test/helpers/runtimes.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test and npm run test:node in cloud/push-relay)
 * <module-headers:end>
 */
import { b64urlDecode, validate } from "@yaran/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { APP, fixture, NOW, ORIGIN, orgSigner, PLAY_APP, pushHeaders, REG } from "./helpers/env.ts";
import { RUNTIMES, startRelay, type RelayHarness } from "./helpers/runtimes.ts";

const wrap = fixture("push/relay-wrapping.json");
const body = b64urlDecode(wrap.body_b64url)!;
let tokens = 0;
const apnsToken = () => (++tokens).toString(16).padStart(64, "a");

describe.each(RUNTIMES)("relay on the %s runtime", (runtime) => {
  let r: RelayHarness;
  let logSpy: ReturnType<typeof vi.spyOn>;
  const secrets: string[] = [];
  beforeAll(async () => {
    r = await startRelay(runtime);
  });
  afterAll(async () => {
    await r.close();
  });
  afterEach(() => {
    const printed = JSON.stringify(logSpy.mock.calls);
    for (const s of secrets) expect(printed).not.toContain(s);
    expect(printed).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
    logSpy.mockRestore();
    r.apns.calls = [];
    r.apns.responder = () => ({ status: 200 });
  });
  const spy = () => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  };

  async function mintApns(token = apnsToken(), environment: "production" | "sandbox" = "production"): Promise<{ endpoint: string; path: string; token: string }> {
    const { publicKey } = await orgSigner();
    const res = await r.request("/v1/endpoints", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Yaran-Protocol": "1" },
      body: JSON.stringify({ kind: "apns", app_id: APP, apns_token: token, apns_environment: environment, vapid_public_key: publicKey, registration_id: REG }),
    });
    expect(res.status).toBe(201);
    const { endpoint } = (await res.json()) as { endpoint: string };
    secrets.push(token, endpoint.split("/w/")[1]!);
    return { endpoint, path: new URL(endpoint).pathname, token };
  }

  const push = async (path: string, headers?: Record<string, string>, payload: Uint8Array = body) =>
    r.request(path, { method: "POST", headers: headers ?? (await pushHeaders()), body: payload as BodyInit });

  const errorCode = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

  it("serves RelayMeta", async () => {
    spy();
    const res = await r.request("/v1/meta");
    expect(res.status).toBe(200);
    expect(res.headers.get("Yaran-Protocol")).toBe("1");
    const meta = await res.json();
    expect(validate("RelayMeta", meta).valid).toBe(true);
    expect(meta).toEqual({ service: "yaran-push-relay", protocol: { min: 1, max: 1 }, apps: [APP, PLAY_APP], channels: ["apns", "fcm"], endpoint_key_id: "k2" });
  });

  it("mints an endpoint and relays a push to APNs, answering 201", async () => {
    spy();
    const { endpoint, path, token } = await mintApns();
    expect(endpoint.startsWith(`${ORIGIN}/w/v1.k2.`)).toBe(true);
    expect(validate("EndpointMintResponse", { endpoint }).valid).toBe(true);
    const res = await push(path);
    expect(res.status).toBe(201);
    expect(r.apns.calls[0]!.path).toBe(r.apnsPath("production", token));
    expect(r.apns.calls[0]!.headers.authorization).toMatch(/^bearer eyJ/);
  });

  it("uses the sandbox host for a sandbox endpoint", async () => {
    spy();
    const { path, token } = await mintApns(apnsToken(), "sandbox");
    expect((await push(path)).status).toBe(201);
    expect(r.apns.calls[0]!.path).toBe(r.apnsPath("sandbox", token));
  });

  it.each(wrap.apns as { name: string; urgency: string; topic: string | null; ttl: number; headers: Record<string, string>; payload: unknown }[])(
    "wraps byte-equal to 02's fixture: $name",
    async (c) => {
      spy();
      const { path } = await mintApns();
      const res = await push(path, await pushHeaders({ Urgency: c.urgency, TTL: String(c.ttl), Topic: c.topic }));
      expect(res.status).toBe(201);
      const call = r.apns.calls[0]!;
      expect(call.body).toBe(JSON.stringify(c.payload));
      const { authorization: _a, "content-type": ct, ...apnsHeaders } = call.headers;
      expect(ct).toBe("application/json");
      expect(apnsHeaders).toEqual(c.headers);
    },
  );

  it("keeps the APNs payload within 4096 bytes at the 2,900-byte maximum body", async () => {
    spy();
    const { path } = await mintApns();
    expect((await push(path, undefined, new Uint8Array(2900).fill(0xab))).status).toBe(201);
    expect(new TextEncoder().encode(r.apns.calls[0]!.body).length).toBeLessThanOrEqual(4096);
  });

  it.each([
    [200, "", 201, null],
    [410, '{"reason":"Unregistered"}', 410, "push_endpoint_gone"],
    [400, '{"reason":"BadDeviceToken"}', 410, "push_endpoint_gone"],
    [400, '{"reason":"DeviceTokenNotForTopic"}', 410, "push_endpoint_gone"],
    [400, '{"reason":"BadCollapseId"}', 400, "bad_request"],
    [413, '{"reason":"PayloadTooLarge"}', 413, "payload_too_large"],
    [429, '{"reason":"TooManyRequests"}', 429, "rate_limited"],
    [403, '{"reason":"ExpiredProviderToken"}', 502, "relay_upstream_failed"],
    [500, '{"reason":"InternalServerError"}', 503, "unavailable"],
    [503, '{"reason":"ServiceUnavailable"}', 503, "unavailable"],
  ])("maps APNs %i %s to %i", async (status, apnsBody, want, code) => {
    spy();
    r.apns.responder = () => ({ status, body: apnsBody });
    const { path } = await mintApns();
    const res = await push(path);
    expect(res.status).toBe(want);
    if (code) expect(await errorCode(res)).toBe(code);
    if (want === 429 || want === 503) expect(res.headers.get("Retry-After")).toBe("60");
    if (code === "relay_upstream_failed") expect(JSON.stringify(logSpy.mock.calls)).toContain("ExpiredProviderToken");
  });

  it("relays an fcm endpoint through FCM v1 (G5 fallback)", async () => {
    spy();
    const { publicKey } = await orgSigner();
    const fcmToken = `fcm-token-${runtime}-abcdefghijklmnopqrstuvwxyz`;
    secrets.push(fcmToken);
    const res = await r.request("/v1/endpoints", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Yaran-Protocol": "1" },
      body: JSON.stringify({ kind: "fcm", app_id: PLAY_APP, fcm_token: fcmToken, vapid_public_key: publicKey, registration_id: REG }),
    });
    expect(res.status).toBe(201);
    const { endpoint } = (await res.json()) as { endpoint: string };
    secrets.push(endpoint.split("/w/")[1]!);
    expect((await push(new URL(endpoint).pathname)).status).toBe(201);
    const sent = JSON.parse(r.google.sendCalls.at(-1)!.body);
    expect(sent.message).toMatchObject({ token: fcmToken, data: { v: "1", r: REG, y: wrap.body_b64url }, android: { priority: "HIGH", ttl: "3600s" } });
    r.google.sendResponder = () => ({ status: 404, body: '{"error":{"status":"NOT_FOUND","details":[{"errorCode":"UNREGISTERED"}]}}' });
    const gone = await push(new URL(endpoint).pathname);
    expect(gone.status).toBe(410);
    r.google.sendResponder = () => ({ status: 200, body: "{}" });
  });

  describe("refusals", () => {
    it("refuses an unknown app_id with relay_app_unknown", async () => {
      spy();
      const { publicKey } = await orgSigner();
      const res = await r.request("/v1/endpoints", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Yaran-Protocol": "1" },
        body: JSON.stringify({ kind: "apns", app_id: "com.example.other", apns_token: apnsToken(), apns_environment: "production", vapid_public_key: publicKey, registration_id: REG }),
      });
      expect(res.status).toBe(400);
      expect(await errorCode(res)).toBe("relay_app_unknown");
    });

    it("refuses a malformed mint and one without Yaran-Protocol", async () => {
      spy();
      const bad = await r.request("/v1/endpoints", { method: "POST", headers: { "Content-Type": "application/json", "Yaran-Protocol": "1" }, body: '{"kind":"apns"}' });
      expect(await errorCode(bad)).toBe("validation_failed");
      const noVersion = await r.request("/v1/endpoints", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      expect(await errorCode(noVersion)).toBe("protocol_unsupported");
    });

    it("refuses an unknown kid and a bad tag with relay_endpoint_invalid", async () => {
      spy();
      const { path } = await mintApns();
      const unknownKid = path.replace("/w/v1.k2.", "/w/v1.k9.");
      expect(await errorCode(await push(unknownKid))).toBe("relay_endpoint_invalid");
      const last = path.at(-1) === "A" ? "B" : "A";
      const res = await push(path.slice(0, -1) + last);
      expect(res.status).toBe(404);
      expect(await errorCode(res)).toBe("relay_endpoint_invalid");
      expect(r.apns.calls).toHaveLength(0);
    });

    it("refuses a VAPID key other than the one bound at mint (403) and bad JWTs (401)", async () => {
      spy();
      const { path } = await mintApns();
      for (const c of fixture("webpush/vapid-vectors.json").cases as { name: string; authorization: string | null; expect: string }[]) {
        if (c.expect === "ok") continue;
        // The fixture's tokens are pinned to its own clock and audience; the relay checks the same rules.
        const headers = await pushHeaders({ Authorization: c.authorization?.replace("https://relay.example.com", ORIGIN) ?? null });
        const res = await push(path, headers);
        expect(await errorCode(res)).toBe(c.expect);
      }
      expect(await errorCode(await push(path, await pushHeaders({}, { aud: "https://other.example.com" })))).toBe("relay_vapid_invalid");
      expect(await errorCode(await push(path, await pushHeaders({}, { exp: NOW - 1 })))).toBe("relay_vapid_invalid");
      expect(await errorCode(await push(path, await pushHeaders({}, { exp: NOW + 24 * 3600 + 1 })))).toBe("relay_vapid_invalid");
      expect(r.apns.calls).toHaveLength(0);
    });

    it("refuses a missing TTL, a wrong Content-Encoding and a bad Urgency with 400", async () => {
      spy();
      const { path } = await mintApns();
      for (const over of [{ TTL: null }, { "Content-Encoding": "aesgcm" }, { Urgency: "urgent" }, { Topic: "x".repeat(33) }] as Record<string, string | null>[]) {
        const res = await push(path, await pushHeaders(over));
        expect(res.status).toBe(400);
        expect(await errorCode(res)).toBe("bad_request");
      }
    });

    it("refuses a 2,901-byte body with 413", async () => {
      spy();
      const { path } = await mintApns();
      const res = await push(path, undefined, new Uint8Array(2901));
      expect(res.status).toBe(413);
      expect(await errorCode(res)).toBe("payload_too_large");
    });

    it("rate-limits pushes per device token with 429 and Retry-After", async () => {
      spy();
      const { path } = await mintApns();
      for (let i = 0; i < 5; i++) expect((await push(path)).status).toBe(201);
      const res = await push(path);
      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).toBe("60");
    });

    it("answers 404 for an unknown route and 405 for a wrong method", async () => {
      spy();
      expect((await r.request("/nope")).status).toBe(404);
      expect((await r.request("/v1/meta", { method: "POST" })).status).toBe(405);
      expect((await r.request("/w/v1.k2.abc")).status).toBe(405);
    });
  });
});
