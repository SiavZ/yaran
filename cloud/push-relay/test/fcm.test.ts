/**
 * The G5 fallback's Google side against a mock: the RS256 service-account assertion and
 * token exchange, token caching and refresh, the FCM v1 message shape, and the answer
 * mapping (UNREGISTERED and 404 gone, 400, 429, 401 dropping the cached token, 5xx).
 *
 * <module-headers:begin>
 * Uses:
 * test/fcm.test.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/fcm/client.ts
 * ├── src/fcm/oauth.ts
 * └── test/helpers/env.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test and npm run test:node in cloud/push-relay)
 * <module-headers:end>
 */
import { b64urlDecode, utf8 } from "@yaran/protocol";
import { describe, expect, it } from "vitest";
import { FcmClient } from "../src/fcm/client.ts";
import { FCM_SCOPE, FcmTokenSource } from "../src/fcm/oauth.ts";
import { credentials, MockGoogle, NOW, REG } from "./helpers/env.ts";

const input = { urgency: "very-low" as const, topic: "ymz4wvfQl4P7VBQ1dIz_qZ4g7zOVj7re", ttl: 600, registrationId: REG, body: "AAAA", appId: "com.example.yaran.play", now: NOW };

async function setup() {
  const creds = await credentials();
  const google = new MockGoogle();
  const tokens = new FcmTokenSource(creds.env.FCM_SERVICE_ACCOUNT!, google.fetch);
  return { creds, google, tokens, client: new FcmClient("yaran-test", tokens, google.fetch) };
}

describe("OAuth", () => {
  it("exchanges a verifiable RS256 assertion with the messaging scope", async () => {
    const { creds, google, tokens } = await setup();
    expect(await tokens.token(NOW)).toBe("ya29.token-1");
    const form = new URLSearchParams(google.tokenCalls[0]!.body);
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const [h, c, s] = form.get("assertion")!.split(".") as [string, string, string];
    const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(c)!));
    expect(claims).toEqual({ iss: "relay@yaran-test.iam.gserviceaccount.com", scope: FCM_SCOPE, aud: "https://oauth2.googleapis.com/token", iat: NOW, exp: NOW + 3600 });
    expect(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", creds.fcmPublic, b64urlDecode(s)! as BufferSource, utf8.encode(`${h}.${c}`) as BufferSource)).toBe(true);
  });

  it("caches until 300 s before expiry, then refreshes; concurrent callers share one exchange", async () => {
    const { google, tokens } = await setup();
    await Promise.all([tokens.token(NOW), tokens.token(NOW)]);
    expect(await tokens.token(NOW + 3299)).toBe("ya29.token-1");
    expect(google.tokenCalls).toHaveLength(1);
    expect(await tokens.token(NOW + 3300)).toBe("ya29.token-2");
  });

  it("refuses a service account without a key", () => {
    expect(() => new FcmTokenSource('{"client_email":"x"}')).toThrow(/FCM_SERVICE_ACCOUNT/);
  });
});

describe("FCM v1 send", () => {
  it("sends 02's data message with the enum priority, ttl and collapse key", async () => {
    const { google, client } = await setup();
    expect(await client.send("device-token", input)).toEqual({ kind: "delivered", status: 200 });
    const call = google.sendCalls[0]!;
    expect(call.url).toBe("https://fcm.googleapis.com/v1/projects/yaran-test/messages:send");
    expect(call.headers.authorization).toBe("Bearer ya29.token-1");
    expect(JSON.parse(call.body)).toEqual({
      message: { token: "device-token", data: { v: "1", r: REG, y: "AAAA" }, android: { priority: "NORMAL", ttl: "600s", collapse_key: input.topic } },
    });
  });

  it.each([
    [404, "{}", "gone"],
    [400, '{"error":{"status":"INVALID_ARGUMENT","details":[{"errorCode":"UNREGISTERED"}]}}', "gone"],
    [400, '{"error":{"status":"INVALID_ARGUMENT"}}', "bad_request"],
    [429, "{}", "rate_limited"],
    [403, '{"error":{"status":"PERMISSION_DENIED"}}', "misconfigured"],
    [500, "{}", "unavailable"],
  ])("maps %i %s to %s", async (status, body, kind) => {
    const { google, client } = await setup();
    google.sendResponder = () => ({ status, body });
    expect((await client.send("device-token", input)).kind).toBe(kind);
  });

  it("drops the cached token on 401 so the next send re-exchanges", async () => {
    const { google, client } = await setup();
    google.sendResponder = () => ({ status: 401, body: '{"error":{"status":"UNAUTHENTICATED"}}' });
    expect((await client.send("device-token", input)).kind).toBe("misconfigured");
    google.sendResponder = () => ({ status: 200, body: "{}" });
    await client.send("device-token", input);
    expect(google.tokenCalls).toHaveLength(2);
  });

  it("answers unavailable when the token exchange cannot be reached", async () => {
    const creds = await credentials();
    const down = (async () => {
      throw new TypeError("offline");
    }) as typeof fetch;
    const client = new FcmClient("yaran-test", new FcmTokenSource(creds.env.FCM_SERVICE_ACCOUNT!, down), down);
    expect(await client.send("device-token", input)).toEqual({ kind: "unavailable", status: 0, reason: "network" });
  });
});
