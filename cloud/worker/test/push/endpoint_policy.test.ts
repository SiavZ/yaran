/**
 * The registration endpoint policy: the table of accepted and refused URLs and keys,
 * including SSRF shapes, channel coherence and the relay switches.
 *
 * <module-headers:begin>
 * Uses:
 * endpoint_policy.test.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── cloud/worker/src/push/endpoint_policy.ts
 * └── helpers/fakes.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test in cloud/worker/test/push)
 * <module-headers:end>
 */
import { b64urlEncode, generateEcdhKeyPair, type PushChannel } from "@yaran/protocol";
import { beforeAll, describe, expect, it } from "vitest";
import { checkPushEndpoint, type EndpointContext } from "../../src/push/endpoint_policy.ts";
import { settingsWith } from "./helpers/fakes.ts";

const ctx: EndpointContext = { settings: settingsWith({}), zoneName: "example.org", controlPlaneHost: "cp.example.org" };
const RELAY = `https://relay.example.com/w/v1.k1.${"A".repeat(40)}`;
let p256dh = "";
const auth = b64urlEncode(new Uint8Array(16).fill(7));

beforeAll(async () => {
  p256dh = b64urlEncode((await generateEcdhKeyPair()).publicRaw);
});

const sub = (endpoint: string, channel: PushChannel = "unifiedpush", keys: { p256dh?: string; auth?: string } = {}) => ({
  kind: "webpush" as const,
  channel,
  endpoint,
  keys: { p256dh: keys.p256dh ?? p256dh, auth: keys.auth ?? auth },
});

describe("accepted", () => {
  it.each<[string, PushChannel]>([
    ["https://updates.push.services.mozilla.com/wpush/v2/gAAAA", "unifiedpush"],
    ["https://ntfy.sh:443/upAbc?up=1", "unifiedpush"],
    ["https://fcm.googleapis.com/fcm/send/abc:def", "fcm_embedded"],
    ["https://fcm.googleapis.com/wp/abc", "fcm_embedded"],
    [RELAY, "apns_relay"],
    [RELAY, "fcm_relay"],
  ])("%s (%s)", async (endpoint, channel) => {
    const v = await checkPushEndpoint(sub(endpoint, channel), ctx);
    expect(v).toMatchObject({ ok: true, host: new URL(endpoint).hostname });
  });
});

describe("refused as push_endpoint_invalid", () => {
  it.each<[string, string, PushChannel?]>([
    ["http", "http://up.example.com/x"],
    ["IPv4 host", "https://203.0.113.9/x"],
    ["hex IPv4 host", "https://0x7f.1/x"],
    ["IPv6 host", "https://[2001:db8::1]/x"],
    ["port 8443", "https://up.example.com:8443/x"],
    ["userinfo", "https://user:pw@up.example.com/x"],
    ["single label", "https://intranet/x"],
    ["localhost", "https://localhost/x"],
    [".internal", "https://push.corp.internal/x"],
    ["workers.dev", "https://evil.someone.workers.dev/x"],
    ["own zone host", "https://my-laptop.example.org/x"],
    ["the zone apex", "https://example.org/x"],
    ["the control plane", "https://cp.example.org/x"],
    ["2049-byte URL", `https://up.example.com/${"a".repeat(2049 - "https://up.example.com/".length)}`],
    ["not a URL", "::nope"],
    ["embedded FCM on another host", "https://fcm.example.com/fcm/send/x", "fcm_embedded"],
    ["embedded FCM on another path", "https://fcm.googleapis.com/v1/x", "fcm_embedded"],
    ["relay without the endpoint shape", "https://relay.example.com/push/abc", "apns_relay"],
    ["relay with a query", `${RELAY}?x=1`, "apns_relay"],
    ["relay on fcm.googleapis.com", `https://fcm.googleapis.com/w/v1.k1.${"A".repeat(40)}`, "fcm_relay"],
  ])("%s", async (_, endpoint, channel) => {
    const v = await checkPushEndpoint(sub(endpoint, channel ?? "unifiedpush"), ctx);
    expect(v).toMatchObject({ ok: false, code: "push_endpoint_invalid" });
  });

  it("accepts a 2048-byte URL", async () => {
    const endpoint = `https://up.example.com/${"a".repeat(2048 - "https://up.example.com/".length)}`;
    expect((await checkPushEndpoint(sub(endpoint), ctx)).ok).toBe(true);
  });

  it("refuses a 64-byte p256dh", async () => {
    const v = await checkPushEndpoint(sub("https://up.example.com/x", "unifiedpush", { p256dh: b64urlEncode(new Uint8Array(64).fill(4)) }), ctx);
    expect(v).toMatchObject({ ok: false, code: "push_endpoint_invalid" });
  });

  it("refuses an off-curve point", async () => {
    const raw = new Uint8Array(65).fill(1);
    raw[0] = 4;
    const v = await checkPushEndpoint(sub("https://up.example.com/x", "unifiedpush", { p256dh: b64urlEncode(raw) }), ctx);
    expect(v).toMatchObject({ ok: false, code: "push_endpoint_invalid" });
  });

  it("refuses an auth secret that is not 16 bytes", async () => {
    const v = await checkPushEndpoint(sub("https://up.example.com/x", "unifiedpush", { auth: b64urlEncode(new Uint8Array(15)) }), ctx);
    expect(v).toMatchObject({ ok: false, code: "push_endpoint_invalid" });
  });
});

describe("relay switches", () => {
  it("refuses relay channels while relays are off (reason disabled)", async () => {
    const v = await checkPushEndpoint(sub(RELAY, "apns_relay"), { ...ctx, settings: settingsWith({ relay_allowed: false }) });
    expect(v).toMatchObject({ ok: false, code: "push_relay_disallowed", details: { reason: "disabled" } });
  });
  it("refuses a relay outside a non-empty allowlist (reason not_allowlisted)", async () => {
    const v = await checkPushEndpoint(sub(RELAY, "fcm_relay"), { ...ctx, settings: settingsWith({ allowed_relays: ["https://relay.other.com"] }) });
    expect(v).toMatchObject({ ok: false, code: "push_relay_disallowed", details: { reason: "not_allowlisted" } });
  });
  it("accepts an allowlisted relay", async () => {
    const v = await checkPushEndpoint(sub(RELAY, "apns_relay"), { ...ctx, settings: settingsWith({ allowed_relays: ["https://relay.example.com"] }) });
    expect(v).toEqual({ ok: true, host: "relay.example.com", origin: "https://relay.example.com" });
  });
});
