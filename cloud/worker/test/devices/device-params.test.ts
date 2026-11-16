/**
 * Accept/refuse tables for the device registration validators.
 *
 * Pins the push-endpoint SSRF rules (T57), the relay rules, the key checks and the label check one case at a time.
 *
 * <module-headers:begin>
 * Uses:
 * test/devices/device-params.test.ts
 * ├── src/devices/device-params.ts
 * ├── src/http/responses.ts
 * ├── test/devices/device-fixtures.ts
 * └── test/phase06/fakes.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test in cloud/worker (workerd, or Node for test/provisioning))
 * <module-headers:end>
 */
import { describe, expect, it } from "vitest";
import { checkLabel, checkPatch, checkRegistration } from "../../src/devices/device-params.ts";
import { HttpError } from "../../src/http/responses.ts";
import { defaultSettings } from "../phase06/fakes.ts";
import { registration } from "./device-fixtures.ts";

const scope = { controlPlaneHost: "cp.example.com", zoneName: "example.com" };

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof HttpError ? e.code : `threw ${String(e)}`;
  }
}

async function asyncCodeOf(p: Promise<unknown>): Promise<{ code: string; details?: Record<string, unknown> } | null> {
  try {
    await p;
    return null;
  } catch (e) {
    if (!(e instanceof HttpError)) throw e;
    return e.details ? { code: e.code, details: e.details } : { code: e.code };
  }
}

// The endpoint rules are 08's policy (push/endpoint_policy.ts), reached through 06's
// registration check exactly as W12 reaches them.
const withEndpoint = async (endpoint: string, channel = "unifiedpush") => {
  const reg = await registration();
  return { ...reg, push: { ...reg.push, channel, endpoint } };
};

describe("push endpoint SSRF rules", () => {
  const push = defaultSettings().push;
  const accepted: [string, string][] = [
    ["https://fcm.googleapis.com/fcm/send/abc", "fcm.googleapis.com"],
    ["https://updates.push.services.mozilla.com/wpush/v2/x", "updates.push.services.mozilla.com"],
    ["https://ntfy.sh:443/upabc?up=1", "ntfy.sh"],
    ["https://bücher.example.org/up", "xn--bcher-kva.example.org"],
  ];
  it.each(accepted)("accepts %s", async (url, host) => expect((await checkRegistration(await withEndpoint(url), scope, push)).push?.endpointHost).toBe(host));

  const refused = [
    "http://fcm.googleapis.com/x",
    "https://user:pw@fcm.googleapis.com/x",
    "https://user@fcm.googleapis.com/x",
    "https://fcm.googleapis.com:8443/x",
    "https://localhost/x",
    "https://push.localhost/x",
    "https://127.0.0.1/x",
    "https://127.0.0.1:80/x",
    "https://2130706433/x",
    "https://0x7f.1/x",
    "https://0177.0.0.1/x",
    "https://[::1]/x",
    "https://[fd00::1]/x",
    "https://printer.local/x",
    "https://db.internal/x",
    "https://1.0.0.127.in-addr.arpa/x",
    "https://intranet/x",
    "https://fcm.googleapis.com./x",
    "https://cp.example.com./x",
    "https://cp.example.com/x",
    "https://laptop-ada.example.com/x",
    "https://example.com/x",
    "https://evil.workers.dev/x",
    `https://fcm.googleapis.com/${"a".repeat(2049 - "https://fcm.googleapis.com/".length)}`,
  ];
  // The 02 schema already refuses a non-https or over-long endpoint (validation_failed).
  it.each(refused)("refuses %s", async (url) =>
    expect((await asyncCodeOf(checkRegistration(await withEndpoint(url), scope, push)))?.code).toMatch(/^(push_endpoint_invalid|validation_failed)$/));

  it("accepts a URL of exactly 2048 characters", async () => {
    const url = `https://fcm.googleapis.com/${"a".repeat(2048 - "https://fcm.googleapis.com/".length)}`;
    expect((await checkRegistration(await withEndpoint(url), scope, push)).push?.endpointHost).toBe("fcm.googleapis.com");
  });
});

describe("relay rules", () => {
  const push = defaultSettings().push;
  const relay = "https://relay.example.net/w/v1.k1.abcdefghijklmnopqrstuvwxyz";
  it("allows any https relay by default and ignores direct channels", async () => {
    expect(await asyncCodeOf(checkRegistration(await withEndpoint(relay, "apns_relay"), scope, push))).toBeNull();
    expect(await asyncCodeOf(checkRegistration(await withEndpoint("https://ntfy.sh/x"), scope, { ...push, relay_allowed: false }))).toBeNull();
  });
  it("refuses with reason disabled and not_allowlisted", async () => {
    expect(await asyncCodeOf(checkRegistration(await withEndpoint(relay, "fcm_relay"), scope, { ...push, relay_allowed: false })))
      .toEqual({ code: "push_relay_disallowed", details: { reason: "disabled" } });
    const listed = { ...push, allowed_relays: ["https://relay.yaran.example"] };
    expect(await asyncCodeOf(checkRegistration(await withEndpoint("https://relay.yaran.example/w/v1.k1.abcdefghijklmnopqrstuvwxyz", "apns_relay"), scope, listed))).toBeNull();
    expect(await asyncCodeOf(checkRegistration(await withEndpoint(relay, "apns_relay"), scope, listed)))
      .toEqual({ code: "push_relay_disallowed", details: { reason: "not_allowlisted" } });
  });
});

describe("registration keys, label and mutes", () => {
  const push = defaultSettings().push;
  it("accepts a valid registration", async () => {
    const reg = await registration();
    const c = await checkRegistration(reg, scope, push);
    expect(c.deviceKey).toHaveLength(65);
    expect(c.push?.endpointHost).toBe("fcm.googleapis.com");
  });
  it("refuses an off-curve device key, an off-curve or 64-byte p256dh and a short auth", async () => {
    const reg = await registration();
    const offCurve = `${reg.device_key.slice(0, -2)}AA`;
    expect(await asyncCodeOf(checkRegistration({ ...reg, device_key: offCurve }, scope, push))).toMatchObject({ code: "validation_failed" });
    const withKeys = (keys: Record<string, string>) => ({ ...reg, push: { ...reg.push, keys: { ...(reg.push as { keys: Record<string, string> }).keys, ...keys } } });
    expect(await asyncCodeOf(checkRegistration(withKeys({ p256dh: offCurve }), scope, push))).toMatchObject({ code: "validation_failed" });
    expect(await asyncCodeOf(checkRegistration(withKeys({ p256dh: "B" + "A".repeat(84) }), scope, push))).toMatchObject({ code: "validation_failed" });
    expect(await asyncCodeOf(checkRegistration(withKeys({ auth: "AAAAAAAAAAAAAAAAAAAAA" }), scope, push))).toMatchObject({ code: "validation_failed" });
  });
  it("refuses a bidi or control character in the label, an empty or 65-char label and a duplicate mute", async () => {
    expect(codeOf(() => checkLabel("Ada‮enohp"))).toBe("validation_failed");
    expect(codeOf(() => checkLabel("Ada\u0007"))).toBe("validation_failed");
    expect(codeOf(() => checkLabel("Ada's Pixel"))).toBeNull();
    const reg = await registration();
    for (const bad of [{ label: "" }, { label: "x".repeat(65) }, { muted_machine_ids: [reg.install_id, reg.install_id] }, { app_version: "1.2" }]) {
      expect(await asyncCodeOf(checkRegistration({ ...reg, ...bad }, scope, push))).toMatchObject({ code: "validation_failed" });
    }
    expect(await asyncCodeOf(checkRegistration({ ...reg, push: { kind: "none", endpoint: "https://x.example" } }, scope, push))).toMatchObject({ code: "validation_failed" });
  });
  it("needs at least one patch field", () => {
    expect(codeOf(() => checkPatch({}))).toBe("validation_failed");
    expect(codeOf(() => checkPatch({ mute_all: true }))).toBeNull();
  });
});
