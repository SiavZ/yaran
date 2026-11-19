/**
 * The mute intent of one org, through one per-org turn (round 9): a successful partial patch
 * carries every field still owed, two quick changes are each decided against what the other
 * left, the 100-machine bound is judged at the turn, and a reconcile whose retry goes offline
 * publishes the mutes in force, never the Worker's older ones.
 *
 * <module-headers:begin>
 * Uses:
 * src/push/muteIntent.test.ts
 * ├── @yaran/machine-view:src/index.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/push/muteSync.ts
 * ├── src/push/pushRegistration.ts
 * └── src/push/pushTestKit.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test in mobile/app)
 * <module-headers:end>
 */
import type { ApiResult } from "@yaran/machine-view";
import type { Device, DevicePatch } from "@yaran/protocol";
import { describe, expect, it } from "vitest";

import { machineMute, MuteSync } from "./muteSync.ts";
import { reconcileOrg, StalePushOrg, type PushDeps } from "./pushRegistration.ts";
import { device, fakePush, listing, MACHINE, ORG } from "./pushTestKit.ts";

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const C = "cccccccc-0000-4000-8000-000000000003";

/**
 * A Worker for one device: PATCHes are answered in order from `answers` (a promise holds one),
 * an "ok" applies the body to the device the Worker keeps, and GET lists that device.
 */
function worker(start: Device = device()) {
  let server = start;
  const patches: DevicePatch[] = [];
  const queue: (ApiResult | "ok" | Promise<ApiResult | "ok">)[] = [];
  const mirrors: unknown[] = [];
  const { push } = fakePush();
  push.setLocalMutes = async ({ mutes }) => void mirrors.push(mutes);
  const deps: PushDeps = {
    push,
    session: {
      meta: async () => (await import("./pushTestKit.ts")).meta(),
      request: async ({ method, body }) => {
        if (method === "GET") return listing(server);
        patches.push(body as DevicePatch);
        const next = await (queue.shift() ?? "ok");
        if (next !== "ok") return next;
        server = { ...server, ...(body as DevicePatch) };
        return { kind: "ok", status: 200, body: server };
      },
    },
  };
  return { deps, patches, queue, mirrors, server: () => server, setServer: (d: Device) => void (server = d) };
}

function held() {
  let release!: (v: ApiResult | "ok") => void;
  const promise = new Promise<ApiResult | "ok">((r) => (release = r));
  return { promise, release };
}

describe("a successful partial patch settles every owed field", () => {
  it("offline mute_all, then machine ids answered ok: one PATCH carries both, nothing stays owed", async () => {
    const w = worker();
    const sync = new MuteSync();
    w.queue.push({ kind: "offline" });
    expect(await sync.apply(w.deps, ORG.orgId, device(), { mute_all: true })).toBe("offline");
    expect(await sync.apply(w.deps, ORG.orgId, device(), { muted_machine_ids: [MACHINE] })).toMatchObject({ mute_all: true, muted_machine_ids: [MACHINE] });
    expect(w.patches.at(-1)).toEqual({ mute_all: true, muted_machine_ids: [MACHINE] });
    expect(sync.hasPending(ORG.orgId)).toBe(false);
    expect(w.mirrors.at(-1)).toMatchObject({ mute_all: true, muted_machine_ids: [MACHINE] });
    expect(await sync.flush(w.deps, ORG.orgId, device())).toBeNull();
  });

  it("the latest value of one field wins, and an unrelated owed field is kept", async () => {
    const w = worker();
    const sync = new MuteSync();
    w.queue.push({ kind: "offline" }, { kind: "offline" });
    await sync.apply(w.deps, ORG.orgId, device(), { mute_all: true, muted_until: "2026-11-17T12:00:00Z" });
    await sync.apply(w.deps, ORG.orgId, device(), { mute_all: false });
    await sync.flush(w.deps, ORG.orgId, device());
    expect(w.patches.at(-1)).toEqual({ mute_all: false, muted_until: "2026-11-17T12:00:00Z" });
  });

  it("a failed exchange restores the mirror to what is in force and keeps what is owed", async () => {
    const w = worker();
    const sync = new MuteSync();
    w.queue.push({ kind: "offline" }, { kind: "tls_error" });
    await sync.apply(w.deps, ORG.orgId, device(), { mute_all: true });
    expect(await sync.apply(w.deps, ORG.orgId, device(), { muted_machine_ids: [MACHINE] })).toBe("failed");
    expect(w.mirrors.at(-1)).toMatchObject({ mute_all: true, muted_machine_ids: [] });
    expect(sync.hasPending(ORG.orgId)).toBe(true);
  });
});

describe("two quick changes are each decided against what the other left", () => {
  it("add A held, add B queued: the second PATCH is [A, B], and the Worker ends with both", async () => {
    const w = worker();
    const sync = new MuteSync();
    const first = held();
    w.queue.push(first.promise);
    const a = sync.apply(w.deps, ORG.orgId, device(), machineMute(A, true));
    const b = sync.apply(w.deps, ORG.orgId, device(), machineMute(B, true));
    first.release("ok");
    await Promise.all([a, b]);
    expect(w.patches).toEqual([{ muted_machine_ids: [A] }, { muted_machine_ids: [A, B] }]);
    expect(w.server().muted_machine_ids).toEqual([A, B]);
  });

  it("an unmute queued behind an add removes only its own machine, mixed with another field", async () => {
    const w = worker(device({ muted_machine_ids: [A] }));
    const sync = new MuteSync();
    const first = held();
    w.queue.push(first.promise);
    const add = sync.apply(w.deps, ORG.orgId, device({ muted_machine_ids: [A] }), machineMute(B, true));
    const all = sync.apply(w.deps, ORG.orgId, device({ muted_machine_ids: [A] }), { mute_all: true });
    const unmute = sync.apply(w.deps, ORG.orgId, device({ muted_machine_ids: [A] }), machineMute(A, false));
    first.release("ok");
    await Promise.all([add, all, unmute]);
    expect(w.server()).toMatchObject({ mute_all: true, muted_machine_ids: [B] });
  });

  it("the 100-machine bound is judged at the turn: 99 muted, two queued adds, the second is full and sends nothing", async () => {
    const ids = Array.from({ length: 99 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    const w = worker(device({ muted_machine_ids: ids }));
    const sync = new MuteSync();
    const first = held();
    w.queue.push(first.promise);
    const a = sync.apply(w.deps, ORG.orgId, device({ muted_machine_ids: ids }), machineMute(A, true));
    const b = sync.apply(w.deps, ORG.orgId, device({ muted_machine_ids: ids }), machineMute(B, true));
    first.release("ok");
    await a;
    expect(await b).toBe("full");
    expect(w.patches).toHaveLength(1);
    expect(w.server().muted_machine_ids).toHaveLength(100);
  });
});

describe("a reconcile publishes the mutes in force", () => {
  it("GET answers unmuted, the owed mute_all retry goes offline: the row is muted, the mirror enforces it, it stays owed", async () => {
    const w = worker();
    const sync = new MuteSync();
    w.queue.push({ kind: "offline" }, { kind: "offline" });
    await sync.apply(w.deps, ORG.orgId, device(), { mute_all: true });
    const r = await reconcileOrg(w.deps, ORG, sync);
    expect(r).toMatchObject({ kind: "row", state: { kind: "muted" }, device: { mute_all: true } });
    expect(w.mirrors.at(-1)).toMatchObject({ mute_all: true });
    expect(sync.hasPending(ORG.orgId)).toBe(true);
  });

  it("a mute queued while a reconcile holds the turn lands after the reconcile publishes", async () => {
    const w = worker();
    const sync = new MuteSync();
    const local = held();
    const plain = w.deps.push.localState;
    w.deps.push.localState = async (o) => (await local.promise, plain(o));
    const published: unknown[] = [];
    const reconcile = reconcileOrg(w.deps, ORG, sync, (r) => void published.push(r));
    await new Promise((r) => setTimeout(r, 0));
    const mute = sync.apply(w.deps, ORG.orgId, device(), { mute_all: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(w.patches).toEqual([]);
    local.release("ok");
    await reconcile;
    expect(published).toMatchObject([{ kind: "row", state: { kind: "active" } }]);
    await mute;
    expect(w.server().mute_all).toBe(true);
    expect(w.mirrors.at(-1)).toMatchObject({ mute_all: true });
  });
});

describe("a turn queued by an org that left touches nothing of the one added again", () => {
  it("old exchange held, old reconcile queued, org forgotten and re-added with an offline [B]: the next mute sends [B, C]", async () => {
    const w = worker();
    const sync = new MuteSync();
    let oldAlive = true;
    const old: PushDeps = { ...w.deps, live: () => oldAlive };
    const fresh: PushDeps = { ...w.deps, live: () => true };
    const first = held();
    w.queue.push(first.promise, { kind: "offline" });
    const oldMute = sync.apply(old, ORG.orgId, device(), { mute_all: true, muted_machine_ids: [A] });
    const oldReconcile = reconcileOrg(old, ORG, sync);
    await new Promise((r) => setTimeout(r, 0));
    // Removed and added again: the old incarnation's turns are now stale.
    oldAlive = false;
    sync.forget(ORG.orgId);
    expect(await sync.apply(fresh, ORG.orgId, device(), machineMute(B, true))).toBe("offline");
    first.release("ok");
    await expect(oldMute).rejects.toBeInstanceOf(StalePushOrg);
    await expect(oldReconcile).rejects.toBeInstanceOf(StalePushOrg);
    const mirrorsBefore = w.mirrors.length;
    await sync.apply(fresh, ORG.orgId, device(), machineMute(C, true));
    expect(w.patches.at(-1)).toEqual({ muted_machine_ids: [B, C] });
    // Only the new org's own mirror writes happened after the old turns ended.
    expect(w.mirrors.slice(mirrorsBefore)).toEqual([
      { mute_all: false, muted_until: null, muted_machine_ids: [B, C] },
      expect.objectContaining({ muted_machine_ids: [B, C] }),
    ]);
  });
});

describe("a registration carries the device the reconcile just listed", () => {
  it("cached unmuted, the Worker now mutes, a partial mute is owed and the subscription is stale: all of it is registered", async () => {
    const w = worker();
    const sync = new MuteSync();
    await reconcileOrg(w.deps, ORG, sync);
    const until = "2026-11-17T18:00:00Z";
    w.queue.push({ kind: "offline" });
    expect(await sync.apply(w.deps, ORG.orgId, device(), { muted_until: until })).toBe("offline");
    // Changed elsewhere (another surface): the Worker's device is now muted.
    w.setServer(device({ mute_all: true, muted_machine_ids: [A] }));
    const registered: unknown[] = [];
    w.deps.push.registerDevice = async (o) => (registered.push(o.mutes), { outcome: "ok", device: { ...w.server(), ...o.mutes } });
    w.deps.push.localState = async () => ({ subscribed: false, channel: "unifiedpush", endpointHost: null, vapidPublicKey: null, relayKeyId: null, relayKeyCurrent: null });
    await reconcileOrg(w.deps, ORG, sync);
    const all = { mute_all: true, muted_machine_ids: [A], muted_until: until };
    expect(registered).toEqual([all]);
    expect(w.mirrors.at(-1)).toEqual(all);
    expect(sync.hasPending(ORG.orgId)).toBe(false);
  });
});
