/**
 * W12, W13, W14 and W31 end to end through the fake pipeline.
 *
 * Registration, listing, mutes, revocation with sign-out-everywhere and the device_revoked answer for a revoked install.
 *
 * <module-headers:begin>
 * Uses:
 * test/devices/devices-route.test.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── test/devices/device-fixtures.ts
 * ├── test/phase06/fakes.ts
 * └── test/phase06/harness.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test in cloud/worker (workerd, or Node for test/provisioning))
 * <module-headers:end>
 */
import { validate, type Device, type DevicePage } from "@yaran/protocol";
import { describe, expect, it } from "vitest";
import { CP_HOST, fakeJwt, makeWorld, seedMachine, seedUser, type SeededUser, type TestWorld } from "../phase06/fakes.ts";
import { CP_AUD, dispatch } from "../phase06/harness.ts";
import { DEVICE_KEYS, p256Point, registration } from "./device-fixtures.ts";

const email = (n: string) => `${n}-${crypto.randomUUID().slice(0, 8)}@example.org`;

function req(u: SeededUser, method: string, path: string, o: { body?: unknown; installId?: string } = {}): Request {
  const headers: Record<string, string> = { "Cf-Access-Jwt-Assertion": fakeJwt({ email: u.email, sub: u.id, exp: 1_900_000_000, aud: [CP_AUD] }) };
  if (o.installId) headers["Yaran-Install-Id"] = o.installId;
  if (o.body !== undefined) headers["Content-Type"] = "application/json";
  return new Request(`https://${CP_HOST}${path}`, { method, headers, ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}) });
}

const call = (w: TestWorld, r: Request) => dispatch(r, w);
const code = async (res: Response) => ((await res.json()) as { error: { code: string; details?: unknown } }).error;

async function setup() {
  const w = await makeWorld();
  // The fake's default VAPID key is a fixture device key; keep the two distinct here.
  w.internal.vapidPublicKey = await p256Point();
  const ada = await seedUser(w.ctx.db, email("ada"));
  return { w, ada };
}

async function register(w: TestWorld, u: SeededUser, over = {}) {
  const reg = await registration(over);
  const res = await call(w, req(u, "POST", "/v1/me/devices", { body: reg, installId: reg.install_id }));
  return { reg, res };
}

describe("W12 POST /v1/me/devices", () => {
  it("creates with 201, updates with 200, and never echoes the key or endpoint", async () => {
    const { w, ada } = await setup();
    const { reg, res } = await register(w, ada);
    expect(res.status).toBe(201);
    const text = await res.text();
    const dev = JSON.parse(text) as Device;
    expect(validate("Device", dev).errors).toEqual([]);
    expect(dev.device_key_fingerprint).toBe(DEVICE_KEYS[0]!.fingerprint);
    expect(dev.push).toMatchObject({ kind: "webpush", channel: "unifiedpush", endpoint_host: "fcm.googleapis.com", vapid_public_key: w.internal.vapidPublicKey });
    expect(dev.push_state).toBe("active");
    expect(dev.current).toBe(true);
    for (const secret of [reg.device_key, reg.push.endpoint, reg.push.keys.auth, reg.push.keys.p256dh]) expect(text).not.toContain(secret);
    const stored = await w.ctx.db.prepare("SELECT endpoint_enc, auth_enc, device_key_fingerprint FROM devices WHERE id = ?").bind(dev.id).first<Record<string, string>>();
    expect(stored!.endpoint_enc).not.toContain(reg.push.endpoint);
    expect(stored!.device_key_fingerprint).toBe(DEVICE_KEYS[0]!.fingerprint);

    const again = await call(w, req(ada, "POST", "/v1/me/devices", { body: { ...reg, label: "Renamed" }, installId: reg.install_id }));
    expect(again.status).toBe(200);
    expect(((await again.json()) as Device).id).toBe(dev.id);
    expect(w.audit.map((a) => a.action)).toEqual(["device.registered", "device.updated"]);
  });

  it("refuses a header/body install_id mismatch", async () => {
    const { w, ada } = await setup();
    const reg = await registration();
    const res = await call(w, req(ada, "POST", "/v1/me/devices", { body: reg, installId: crypto.randomUUID() }));
    expect([res.status, (await code(res)).code]).toEqual([400, "bad_request"]);
  });

  it("refuses a different device key for the same install with 409 and changes nothing", async () => {
    const { w, ada } = await setup();
    const { reg } = await register(w, ada);
    const res = await call(w, req(ada, "POST", "/v1/me/devices", { body: { ...reg, device_key: DEVICE_KEYS[1]!.dk, label: "Changed" }, installId: reg.install_id }));
    expect([res.status, (await code(res)).code]).toEqual([409, "conflict"]);
    const row = await w.ctx.db.prepare("SELECT label, device_key_fingerprint FROM devices WHERE install_id = ?").bind(reg.install_id).first<Record<string, string>>();
    expect(row).toEqual({ label: "Ada's Pixel", device_key_fingerprint: DEVICE_KEYS[0]!.fingerprint });
  });

  it("refuses an off-curve device key with validation_failed", async () => {
    const { w, ada } = await setup();
    const reg = await registration();
    const res = await call(w, req(ada, "POST", "/v1/me/devices", { body: { ...reg, device_key: `${reg.device_key.slice(0, -2)}AA` }, installId: reg.install_id }));
    expect((await code(res)).code).toBe("validation_failed");
  });

  it("enforces the device cap with 409 and audits it", async () => {
    const { w, ada } = await setup();
    w.settings.device_cap_per_user = 2;
    await register(w, ada);
    await register(w, ada);
    const { res } = await register(w, ada);
    expect([res.status, await code(res)]).toEqual([409, expect.objectContaining({ code: "device_cap_reached", details: { limit: 2 } })]);
    expect(w.audit.at(-1)).toMatchObject({ action: "device.cap_refused", outcome: "denied" });
  });

  it("applies the relay rules", async () => {
    const { w, ada } = await setup();
    const relay = (reg: Awaited<ReturnType<typeof registration>>) => ({ ...reg.push, channel: "apns_relay" as const, endpoint: "https://relay.example.net/w/abc" });
    w.settings.push.relay_allowed = false;
    let reg = await registration();
    let res = await call(w, req(ada, "POST", "/v1/me/devices", { body: { ...reg, push: relay(reg) }, installId: reg.install_id }));
    expect([res.status, await code(res)]).toEqual([409, expect.objectContaining({ code: "push_relay_disallowed", details: { reason: "disabled" } })]);
    w.settings.push.relay_allowed = true;
    w.settings.push.allowed_relays = ["https://relay.yaran.example"];
    reg = await registration();
    res = await call(w, req(ada, "POST", "/v1/me/devices", { body: { ...reg, push: relay(reg) }, installId: reg.install_id }));
    expect(await code(res)).toMatchObject({ code: "push_relay_disallowed", details: { reason: "not_allowlisted" } });
  });
});

describe("W13 GET /v1/me/devices", () => {
  it("lists the caller's live devices, marks current, and hides revoked ones", async () => {
    const { w, ada } = await setup();
    const bob = await seedUser(w.ctx.db, email("bob"));
    const a = await register(w, ada);
    const b = await register(w, ada, { push: { kind: "none" } });
    await register(w, bob);
    const bId = ((await b.res.json()) as Device).id;
    await call(w, req(ada, "DELETE", `/v1/me/devices/${bId}`));
    const res = await call(w, req(ada, "GET", "/v1/me/devices", { installId: a.reg.install_id }));
    const text = await res.text();
    const page = JSON.parse(text) as DevicePage;
    expect(validate("DevicePage", page).errors).toEqual([]);
    expect(page.items.map((d) => [d.install_id, d.current])).toEqual([[a.reg.install_id, true]]);
    expect(text).not.toContain(a.reg.push.endpoint);
    expect(text).not.toContain(a.reg.push.keys.auth);
  });
});

describe("W31 PATCH /v1/me/devices/{id}", () => {
  it("patches each field, refuses an empty body, another user's id and a foreign machine", async () => {
    const { w, ada } = await setup();
    const bob = await seedUser(w.ctx.db, email("bob"));
    const mine = await seedMachine(w.ctx.db, ada);
    const bobs = await seedMachine(w.ctx.db, bob);
    const dev = (await (await register(w, ada)).res.json()) as Device;
    const patch = async (u: SeededUser, body: unknown) => call(w, req(u, "PATCH", `/v1/me/devices/${dev.id}`, { body }));
    for (const [body, check] of [
      [{ label: "Work phone" }, (d: Device) => d.label === "Work phone"],
      [{ mute_all: true }, (d: Device) => d.mute_all],
      [{ muted_until: "2030-01-01T00:00:00Z" }, (d: Device) => d.muted_until === "2030-01-01T00:00:00Z"],
      [{ muted_machine_ids: [mine] }, (d: Device) => d.muted_machine_ids[0] === mine],
    ] as const) {
      const res = await patch(ada, body);
      expect(res.status).toBe(200);
      const d = (await res.json()) as Device;
      expect(validate("Device", d).errors).toEqual([]);
      expect(check(d)).toBe(true);
    }
    expect((await code(await patch(ada, {}))).code).toBe("validation_failed");
    expect((await patch(bob, { mute_all: false })).status).toBe(404);
    expect((await code(await patch(ada, { muted_machine_ids: [bobs] }))).code).toBe("validation_failed");
  });
});

describe("W14 DELETE /v1/me/devices/{id}", () => {
  it("clears push, keeps the fingerprint, and answers device_revoked to that install afterwards", async () => {
    const { w, ada } = await setup();
    const { reg, res } = await register(w, ada);
    const dev = (await res.json()) as Device;
    const del = await call(w, req(ada, "DELETE", `/v1/me/devices/${dev.id}`));
    expect(del.status).toBe(204);
    const row = await w.ctx.db.prepare("SELECT endpoint_enc, auth_enc, p256dh, revoked_at, device_key_fingerprint FROM devices WHERE id = ?").bind(dev.id).first<Record<string, unknown>>();
    expect(row).toMatchObject({ endpoint_enc: null, auth_enc: null, p256dh: null, revoked_at: w.clock.now, device_key_fingerprint: DEVICE_KEYS[0]!.fingerprint });
    expect(w.audit.at(-1)).toMatchObject({ action: "device.revoked", detail: { sign_out_everywhere: false } });
    const after = await call(w, req(ada, "GET", "/v1/me/machines", { installId: reg.install_id }));
    expect([after.status, (await code(after)).code]).toEqual([403, "device_revoked"]);
    expect(w.cf.calls).toEqual([]);
  });

  it("revokes Access sessions with sign_out_everywhere and 404s another user's device", async () => {
    const { w, ada } = await setup();
    const bob = await seedUser(w.ctx.db, email("bob"));
    const dev = (await (await register(w, ada)).res.json()) as Device;
    expect((await call(w, req(bob, "DELETE", `/v1/me/devices/${dev.id}`))).status).toBe(404);
    expect((await call(w, req(ada, "DELETE", `/v1/me/devices/${dev.id}?sign_out_everywhere=1`))).status).toBe(204);
    expect(w.cf.calls.map((c) => [c.method, c.path, c.body])).toEqual([["POST", "/accounts/acc123/access/organizations/revoke_user", { email: ada.email }]]);
    expect(w.audit.slice(-2).map((a) => [a.action, a.detail])).toEqual([["device.revoked", { sign_out_everywhere: true }], ["sessions.revoked", undefined]]);
  });
});

describe("Yaran-Install-Id last_seen_at", () => {
  it("stamps at most hourly", async () => {
    const { w, ada } = await setup();
    const { reg, res } = await register(w, ada);
    const id = ((await res.json()) as Device).id;
    const seen = async () => (await w.ctx.db.prepare("SELECT last_seen_at FROM devices WHERE id = ?").bind(id).first<{ last_seen_at: number | null }>())!.last_seen_at;
    const t0 = w.clock.now;
    await call(w, req(ada, "GET", "/v1/me/devices", { installId: reg.install_id }));
    expect(await seen()).toBe(t0);
    w.clock.now = t0 + 3599;
    await call(w, req(ada, "GET", "/v1/me/devices", { installId: reg.install_id }));
    expect(await seen()).toBe(t0);
    w.clock.now = t0 + 3600;
    await call(w, req(ada, "GET", "/v1/me/devices", { installId: reg.install_id }));
    expect(await seen()).toBe(t0 + 3600);
  });
});
