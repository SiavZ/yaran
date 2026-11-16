/**
 * Registration and reconcile against a scripted plugin and Session: missing device, endpoint
 * host change, `gone`/`auth_failed`, VAPID rotation, relay key change, `failing`,
 * `device_revoked`, turn off versus removal, pending drains and mute sync through W31.
 *
 * <module-headers:begin>
 * Uses:
 * src/push/pushRegistration.test.ts
 * ├── src/push/pushRegistration.ts
 * └── src/push/pushTestKit.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test in mobile/app)
 * <module-headers:end>
 */
import { describe, expect, it } from "vitest";
import {
  drainPending,
  MuteSync,
  muteMachine,
  reconcileOrg,
  removeOrgPush,
  rowFromDevice,
  turnOffOrg,
} from "./pushRegistration.ts";
import { device, fakePush, fakeSession, listing, MACHINE, meta, ORG, ROTATED } from "./pushTestKit.ts";

const registered = (calls: { method: string }[]) => calls.filter((c) => c.method === "registerDevice").length;

describe("reconcile", () => {
  it("registers when the Worker has no device for this install", async () => {
    const { push, calls } = fakePush();
    const { session } = fakeSession(() => listing(device({ current: false })));
    const r = await reconcileOrg({ push, session }, ORG, new MuteSync());
    expect(registered(calls)).toBe(1);
    expect(r).toMatchObject({ kind: "row", state: { kind: "active" } });
    const sent = calls.find((c) => c.method === "registerDevice")?.args as Record<string, unknown>;
    expect(sent).toMatchObject({ orgId: "org-1", installId: ORG.installId, pushOff: false });
    expect(sent).not.toHaveProperty("endpoint");
  });

  it.each([
    ["push_state gone (subscription cleared, row kept)", device({ push_state: "gone", push: { kind: "webpush" } }), {}],
    ["push_state auth_failed", device({ push_state: "auth_failed" }), {}],
    ["Device VAPID differs from Meta", device({ push: { kind: "webpush", channel: "unifiedpush", endpoint_host: "ntfy.example.com", vapid_public_key: ROTATED } }), {}],
    ["endpoint host changed", device(), { endpointHost: "other.example.com" }],
    ["relay key id changed", device({ push: { kind: "webpush", channel: "apns_relay", endpoint_host: "ntfy.example.com", vapid_public_key: device().push.vapid_public_key ?? null } }), { relayKeyCurrent: false }],
    ["no local subscription", device(), { subscribed: false }],
  ])("re-registers on %s", async (_name, current, local) => {
    const { push, calls } = fakePush({ local });
    const { session, calls: api } = fakeSession(() => listing(current));
    await reconcileOrg({ push, session }, ORG, new MuteSync());
    expect(registered(calls)).toBe(1);
    expect(api.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("shows failing without re-registering", async () => {
    const { push, calls } = fakePush();
    const { session } = fakeSession(() => listing(device({ push_state: "failing" })));
    const r = await reconcileOrg({ push, session }, ORG, new MuteSync());
    expect(registered(calls)).toBe(0);
    expect(r).toMatchObject({ kind: "row", state: { kind: "delivery_failing" } });
  });

  it("mirrors the Worker's mutes when nothing is stale", async () => {
    const { push, calls } = fakePush();
    const { session } = fakeSession(() => listing(device({ mute_all: true })));
    const r = await reconcileOrg({ push, session }, ORG, new MuteSync());
    expect(r).toMatchObject({ kind: "row", state: { kind: "muted", until: null } });
    expect(calls.find((c) => c.method === "setLocalMutes")?.args).toEqual({
      orgId: "org-1",
      mutes: { mute_all: true, muted_until: null, muted_machine_ids: [] },
    });
  });

  it("device_revoked forgets the org", async () => {
    const { push, calls } = fakePush();
    const { session } = fakeSession(() => ({ kind: "device_revoked" }));
    expect(await reconcileOrg({ push, session }, ORG, new MuteSync())).toEqual({ kind: "revoked" });
    expect(calls.some((c) => c.method === "forgetOrg")).toBe(true);
  });

  it("device_revoked from registration forgets the org", async () => {
    const { push, calls } = fakePush({ register: () => ({ outcome: "device_revoked" }) });
    const { session } = fakeSession(() => listing());
    expect(await reconcileOrg({ push, session }, ORG, new MuteSync())).toEqual({ kind: "revoked" });
    expect(calls.some((c) => c.method === "forgetOrg")).toBe(true);
  });

  it("gates on the capability, the org switch, permission and the off state", async () => {
    const { push } = fakePush();
    const hidden = fakeSession(() => listing(), meta({ capabilities: [] }));
    expect(await reconcileOrg({ push, session: hidden.session }, ORG, new MuteSync())).toEqual({ kind: "hidden" });
    const off = fakeSession(() => listing(), meta({ push: { enabled: false, vapid_public_key: null } }));
    expect(await reconcileOrg({ push, session: off.session }, ORG, new MuteSync())).toMatchObject({ state: { kind: "org_disabled" } });
    const denied = fakePush({ permission: "denied" });
    const { session } = fakeSession(() => listing());
    expect(await reconcileOrg({ push: denied.push, session }, ORG, new MuteSync())).toMatchObject({ state: { kind: "needs_permission" } });
    const none = fakeSession(() => listing(device({ push: { kind: "none" }, push_state: "none" })));
    expect(await reconcileOrg({ push, session: none.session }, ORG, new MuteSync())).toMatchObject({ state: { kind: "turned_off" } });
  });

  it("refuses a native result that carries key material", async () => {
    const leaky = { outcome: "ok", device: { ...device(), push: { kind: "webpush", endpoint: "https://x" } } } as never;
    const { push } = fakePush({ register: () => leaky });
    const { session } = fakeSession(() => listing());
    const r = await reconcileOrg({ push, session }, ORG, new MuteSync());
    expect(r).toMatchObject({ state: { kind: "registration_failed", reason: "native result carried device.push.endpoint" } });
  });

  it("maps native outcomes to row states", async () => {
    const cases = [
      [{ outcome: "no_distributor" }, { kind: "no_distributor" }],
      [{ outcome: "push_unavailable", reason: "no Play services" }, { kind: "push_unavailable", reason: "no Play services" }],
      [{ outcome: "needs_permission" }, { kind: "needs_permission" }],
      [{ outcome: "api_error", status: 409, code: "conflict" }, { kind: "registration_failed", reason: "conflict" }],
      [{ outcome: "offline" }, { kind: "registration_failed", reason: "this phone is offline" }],
    ] as const;
    for (const [result, state] of cases) {
      const { push } = fakePush({ register: () => result as never });
      const { session } = fakeSession(() => listing());
      expect(await reconcileOrg({ push, session }, ORG, new MuteSync())).toMatchObject({ state });
    }
  });

  it("drains orgs queued while the WebView was down", async () => {
    const { push, calls } = fakePush({ pending: ["org-1"], local: { subscribed: false } });
    const { session } = fakeSession(() => listing(device()));
    const out = await drainPending({ push, session }, [ORG, { ...ORG, orgId: "org-2" }], new MuteSync());
    expect([...out.keys()]).toEqual(["org-1"]);
    expect(registered(calls)).toBe(1);
  });
});

describe("off switches", () => {
  it("turn off re-registers with pushOff and never calls W14", async () => {
    const { push, calls } = fakePush({ register: () => ({ outcome: "ok", device: device({ push: { kind: "none" }, push_state: "none" }) }) });
    const { session, calls: api } = fakeSession(() => listing());
    const r = await turnOffOrg({ push, session }, ORG, meta(), device());
    expect(calls.find((c) => c.method === "registerDevice")?.args).toMatchObject({ pushOff: true });
    expect(api).toEqual([]);
    expect(r).toMatchObject({ state: { kind: "turned_off" } });
  });

  it("org removal sends W14, then forgets the keys", async () => {
    const { push, calls } = fakePush();
    const { session, calls: api } = fakeSession(() => ({ kind: "ok", status: 204, body: null }));
    await removeOrgPush({ push, session }, "org-1", "c0ffee00-1234-4abc-bdef-0123456789ab");
    expect(api).toEqual([{ method: "DELETE", path: "/v1/me/devices/c0ffee00-1234-4abc-bdef-0123456789ab", body: undefined }]);
    expect(calls.some((c) => c.method === "forgetOrg")).toBe(true);
  });
});

describe("mutes through W31", () => {
  it("sends DevicePatch fields and mirrors the answer", async () => {
    const { push, calls } = fakePush();
    const updated = device({ muted_until: "2026-11-14T13:00:00Z" });
    const { session, calls: api } = fakeSession(() => ({ kind: "ok", status: 200, body: updated }));
    const sync = new MuteSync();
    for (const patch of [{ mute_all: true }, { muted_until: "2026-11-14T13:00:00Z" }, { muted_machine_ids: [MACHINE] }]) {
      expect(await sync.apply({ push, session }, "org-1", device(), patch)).toEqual(updated);
      expect(api.at(-1)).toEqual({ method: "PATCH", path: `/v1/me/devices/${device().id}`, body: patch });
    }
    expect(calls.filter((c) => c.method === "setLocalMutes").length).toBe(6);
  });

  it("applies locally while offline and sends once back online", async () => {
    const { push, calls } = fakePush();
    let online = false;
    const { session, calls: api } = fakeSession((method) => {
      if (method === "GET") return listing(device());
      return online ? { kind: "ok", status: 200, body: device({ muted_machine_ids: [MACHINE] }) } : { kind: "offline" };
    });
    const sync = new MuteSync();
    expect(await muteMachine({ push, session }, sync, "org-1", device(), MACHINE)).toBe("offline");
    expect(calls.find((c) => c.method === "setLocalMutes")?.args).toMatchObject({ mutes: { muted_machine_ids: [MACHINE] } });
    expect(sync.hasPending("org-1")).toBe(true);
    online = true;
    const r = await reconcileOrg({ push, session }, ORG, sync);
    expect(sync.hasPending("org-1")).toBe(false);
    expect(api.filter((c) => c.method === "PATCH").length).toBe(2);
    expect(r).toMatchObject({ device: { muted_machine_ids: [MACHINE] } });
  });

  it("confirms a machine that was already muted, and refuses past 100", async () => {
    const { push } = fakePush();
    const { session } = fakeSession(() => ({ kind: "offline" }));
    expect(await muteMachine({ push, session }, new MuteSync(), "o", device({ muted_machine_ids: [MACHINE] }), MACHINE)).toBe("unchanged");
    const full = Array.from({ length: 100 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    expect(await muteMachine({ push, session }, new MuteSync(), "o", device({ muted_machine_ids: full }), MACHINE)).toBe("full");
  });

  it("a timed mute that expired is active again", () => {
    expect(rowFromDevice(device({ muted_until: "2026-11-14T12:00:00Z" }), Date.parse("2026-11-14T12:00:01Z"))).toEqual({ kind: "active" });
    expect(rowFromDevice(device({ muted_until: "2026-11-14T12:00:00Z" }), Date.parse("2026-11-14T11:00:00Z"))).toEqual({
      kind: "muted",
      until: "2026-11-14T12:00:00Z",
    });
  });
});
