/**
 * Push work across an erase, a re-add and overlapping exchanges (round 8): nothing ordinary runs
 * while an erase is running, a notification tap keeps the org it arrived for, an older mute
 * answer never retires a newer intent, and one org going stale does not stop a registration
 * drain for the others.
 *
 * <module-headers:begin>
 * Uses:
 * src/push/pushRaces.test.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── @yaran/push:src/index.ts
 * ├── @yaran/secure-store:src/index.ts
 * ├── src/lib/lifecycle.ts
 * ├── src/lib/machinesStore.ts
 * ├── src/lib/native/machineView.ts
 * ├── src/lib/orgStore.ts
 * ├── src/push/pushDeps.ts
 * ├── src/push/pushTestKit.ts
 * └── src/push/pushWiring.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test in mobile/app)
 * <module-headers:end>
 */
import type { MachineSummary } from '@yaran/protocol';
import { Push } from '@yaran/push';
import { SecureStore } from '@yaran/secure-store';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { refreshAllOrgs } from '../lib/lifecycle.ts';
import { machinesStore } from '../lib/machinesStore.ts';
import { MachineView, Session, type ApiResult } from '../lib/native/machineView.ts';
import { addOrg, eraseEverything, orgStore } from '../lib/orgStore.ts';
import { muteSync, pushStore, scopedPushDeps } from './pushDeps.ts';
import { installPush, mutePushMachine, pushAction, reconcilePush } from './pushWiring.ts';
import { device, listing, MACHINE, VAPID } from './pushTestKit.ts';

const listeners = new Map<string, (e: unknown) => void>();
vi.mock('@yaran/push', async (orig) => ({
  ...(await orig<typeof import('@yaran/push')>()),
  Push: {
    addListener: vi.fn(async (name: string, fn: (e: unknown) => void) => (listeners.set(name, fn), { remove: async () => {} })),
    drainPendingRegistrations: vi.fn(async () => ({ orgIds: [] })),
    forgetOrg: vi.fn(async () => {}),
    clearDelivered: vi.fn(async () => {}),
    cacheMachineNames: vi.fn(async () => {}),
    checkPermission: vi.fn(async () => ({ notifications: 'granted' })),
    requestPermission: vi.fn(async () => ({ notifications: 'granted' })),
    registerDevice: vi.fn(async () => ({ kind: 'failed', reason: 'test' })),
    setLocalMutes: vi.fn(async () => {}),
    localState: vi.fn(async () => ({})),
  },
}));

const ORG = { id: 'https://cp.example.com', name: 'Ada', teamDomain: null, addedAt: 'x' };
const ORG_B = { id: 'https://cp2.example.com', name: 'Babbage', teamDomain: null, addedAt: 'x' };
const META = {
  kind: 'ok' as const,
  status: 200,
  body: {
    service: 'yaran-cloud',
    protocol: { min: 1, max: 1 },
    setup: 'closed',
    worker: { version: '1.0.0' },
    org: { name: 'Ada', url: 'https://cp.example.com' },
    access: { team_domain: 'ada.cloudflareaccess.com' },
    capabilities: ['push.webpush'],
    push: { enabled: true, vapid_public_key: VAPID },
  },
};
const tick = () => new Promise((r) => setTimeout(r, 0));
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

afterEach(() => {
  pushStore.set({});
  machinesStore.set({});
  orgStore.set({ loaded: true, orgs: [] });
  muteSync.forget();
  vi.mocked(Session.request).mockReset().mockResolvedValue({ kind: 'offline' });
});

describe('nothing ordinary runs while an erase is running', () => {
  /** Starts an erase and holds it at its vault wipe, with the org still listed. */
  async function eraseHeldAtWipe() {
    orgStore.set({ loaded: true, orgs: [ORG] });
    vi.mocked(Session.meta).mockResolvedValue(META);
    const wipe = deferred<void>();
    vi.mocked(SecureStore.eraseAll).mockImplementationOnce(() => wipe.promise);
    const erasing = eraseEverything();
    await vi.waitFor(() => expect(SecureStore.eraseAll).toHaveBeenCalled());
    expect(orgStore.get().orgs.map((o) => o.id)).toEqual([ORG.id]);
    vi.mocked(Session.installId).mockClear();
    vi.mocked(Session.deviceKey).mockClear();
    vi.mocked(Push.registerDevice).mockClear();
    return async () => (wipe.resolve(), await erasing);
  }
  const nothingMinted = () => {
    expect(Session.installId).not.toHaveBeenCalled();
    expect(Session.deviceKey).not.toHaveBeenCalled();
    expect(Push.registerDevice).not.toHaveBeenCalled();
  };

  it('a reconcile started during the erase, with a fresh ticket, mints nothing', async () => {
    const finish = await eraseHeldAtWipe();
    await reconcilePush(ORG);
    nothingMinted();
    await finish();
  });

  it('Turn on started during the erase mints and registers nothing', async () => {
    const finish = await eraseHeldAtWipe();
    await pushAction(ORG.id, 'turn_on');
    nothingMinted();
    await finish();
  });

  it('a resume during the erase (every org refreshed and reconciled) mints nothing', async () => {
    const finish = await eraseHeldAtWipe();
    refreshAllOrgs();
    await new Promise((r) => setTimeout(r, 20));
    nothingMinted();
    await finish();
  });

  it('control: the same reconcile with no erase asks for the install id', async () => {
    orgStore.set({ loaded: true, orgs: [ORG] });
    vi.mocked(Session.meta).mockResolvedValue(META);
    vi.mocked(Session.installId).mockClear();
    await reconcilePush(ORG);
    expect(Session.installId).toHaveBeenCalledWith({ orgId: ORG.id });
  });
});

describe('a cold notification tap keeps the org it arrived for', () => {
  const summary = { id: MACHINE, name: 'box', hostname: 'box.example.com', url: 'https://box.example.com', status: 'online', status_checked_at: '2026-11-14T12:00:00Z', paired_at: '2026-11-14T12:00:00Z' };
  const LIST: ApiResult = { kind: 'ok', status: 200, body: { items: [summary], next_cursor: null } };

  /** A cold tap (no list yet) whose list refresh is held across an erase and a re-add. */
  async function tapAcrossEraseAndReadd(event: Record<string, unknown>) {
    orgStore.set({ loaded: true, orgs: [ORG] });
    await installPush();
    const refresh = deferred<ApiResult>();
    vi.mocked(Session.request).mockImplementationOnce(() => refresh.promise);
    listeners.get('notificationTapped')!({ orgId: ORG.id, machineId: MACHINE, ...event });
    await vi.waitFor(() => expect(Session.request).toHaveBeenCalled());
    await eraseEverything();
    await addOrg({ id: ORG.id, name: ORG.name, teamDomain: null });
    // The new org has the same machine and its own device row.
    machinesStore.set({ [ORG.id]: { state: 'ready', machines: [summary as MachineSummary], fetchedAt: 0 } });
    pushStore.set({ [ORG.id]: { kind: 'row', state: { kind: 'active' }, device: device() } });
    vi.mocked(Session.request).mockClear();
    vi.mocked(Push.setLocalMutes).mockClear();
    vi.mocked(MachineView.open).mockClear();
    vi.mocked(Push.clearDelivered).mockClear();
    refresh.resolve(LIST);
    await new Promise((r) => setTimeout(r, 20));
  }

  it('Mute this machine sends nothing to the new org: no PATCH, no local mutes', async () => {
    await tapAcrossEraseAndReadd({ action: 'mute_machine' });
    expect(vi.mocked(Session.request).mock.calls.filter((c) => c[0].method === 'PATCH')).toEqual([]);
    expect(Push.setLocalMutes).not.toHaveBeenCalled();
  });

  it('Open opens nothing of the new org and keeps the alert', async () => {
    await tapAcrossEraseAndReadd({ agentId: 'a1', action: 'open' });
    expect(MachineView.open).not.toHaveBeenCalled();
    expect(Push.clearDelivered).not.toHaveBeenCalled();
  });

  it('control: an ordinary cold tap still loads the list, opens the agent and clears its alert', async () => {
    orgStore.set({ loaded: true, orgs: [ORG] });
    await installPush();
    vi.mocked(Session.request).mockResolvedValueOnce(LIST);
    listeners.get('notificationTapped')!({ orgId: ORG.id, machineId: MACHINE, agentId: 'a1', action: 'open' });
    await vi.waitFor(() => expect(MachineView.open).toHaveBeenCalledWith({ orgId: ORG.id, machineId: MACHINE, host: 'box.example.com', route: '#/agent/a1' }));
    await vi.waitFor(() => expect(Push.clearDelivered).toHaveBeenCalled());
  });
});

describe('an older mute answer never retires a newer intent of the same org', () => {
  const live = scopedPushDeps(() => true);
  const lastMirror = () => vi.mocked(Push.setLocalMutes).mock.calls.at(-1)![0].mutes;

  it('A held, B saved offline meanwhile, A answers ok: B stays pending and mirrored, and the next flush sends B', async () => {
    const a = deferred<ApiResult>();
    vi.mocked(Session.request).mockImplementationOnce(() => a.promise).mockResolvedValueOnce({ kind: 'offline' });
    const first = muteSync.apply(live, ORG.id, device(), { mute_all: true });
    await tick();
    const second = muteSync.apply(live, ORG.id, device(), { muted_machine_ids: [MACHINE] });
    a.resolve({ kind: 'ok', status: 200, body: device({ mute_all: true }) });
    await first;
    expect(await second).toBe('offline');
    expect(muteSync.hasPending(ORG.id)).toBe(true);
    // Both intents are mirrored: A's answer and B's own field.
    expect(lastMirror()).toMatchObject({ mute_all: true, muted_machine_ids: [MACHINE] });
    vi.mocked(Session.request).mockResolvedValueOnce({ kind: 'ok', status: 200, body: device({ mute_all: true, muted_machine_ids: [MACHINE] }) });
    await muteSync.flush(live, ORG.id, device());
    expect(vi.mocked(Session.request).mock.calls.at(-1)![0].body).toEqual({ muted_machine_ids: [MACHINE] });
  });

  it("another org's mute is never held behind this org's exchange", async () => {
    const held = deferred<ApiResult>();
    vi.mocked(Session.request).mockImplementationOnce(() => held.promise).mockResolvedValueOnce({ kind: 'offline' });
    void muteSync.apply(live, ORG.id, device(), { mute_all: true });
    await tick();
    expect(await muteSync.apply(live, ORG_B.id, device(), { mute_all: true })).toBe('offline');
    held.resolve({ kind: 'offline' });
  });
});

describe('one org going stale does not stop the registration drain for the others', () => {
  it('A removed while its device request is out: B registers now, not on the next trigger', async () => {
    orgStore.set({ loaded: true, orgs: [ORG, ORG_B] });
    vi.mocked(Session.meta).mockResolvedValue(META);
    vi.mocked(Push.drainPendingRegistrations).mockResolvedValue({ orgIds: [ORG.id, ORG_B.id] });
    const aList = deferred<ApiResult>();
    vi.mocked(Session.request).mockImplementation(async (o) =>
      o.orgId === ORG.id ? aList.promise : { kind: 'ok', status: 200, body: { items: [], next_cursor: null } },
    );
    vi.mocked(Push.registerDevice).mockClear();
    await installPush();
    await vi.waitFor(() => expect(Session.request).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG.id })));
    // A leaves this phone while its device list is out.
    orgStore.set({ loaded: true, orgs: [ORG_B] });
    aList.resolve({ kind: 'ok', status: 200, body: { items: [], next_cursor: null } });
    await vi.waitFor(() => expect(Push.registerDevice).toHaveBeenCalled());
    expect(vi.mocked(Push.registerDevice).mock.calls.map((c) => (c[0] as { orgId: string }).orgId)).toEqual([ORG_B.id]);
    vi.mocked(Push.drainPendingRegistrations).mockResolvedValue({ orgIds: [] });
  });
});

describe('mute callers decide at their turn, from the device the org really has', () => {
  const OTHER = 'bbbbbbbb-0000-4000-8000-000000000002';
  const summary = { id: MACHINE, name: 'box', hostname: 'box.example.com', url: 'https://box.example.com', status: 'online', status_checked_at: '2026-11-14T12:00:00Z', paired_at: '2026-11-14T12:00:00Z' };
  const patches = () => vi.mocked(Session.request).mock.calls.filter((c) => c[0].method === 'PATCH').map((c) => c[0].body);

  /** A Worker for one device: GET lists it, a PATCH is held while `hold` is set, then applied. */
  function worker(listed: boolean) {
    let server = device();
    let gate: Promise<void> | null = null;
    let open!: () => void;
    vi.mocked(Session.meta).mockResolvedValue(META);
    vi.mocked(Session.request).mockImplementation(async ({ method, path, body }) => {
      if (method === 'GET' && path.startsWith('/v1/me/machines')) return { kind: 'ok', status: 200, body: { items: [summary], next_cursor: null } };
      if (method === 'GET') return listed ? listing(server) : listing();
      if (gate) await gate;
      server = { ...server, ...(body as object) };
      return { kind: 'ok', status: 200, body: server };
    });
    return {
      hold: () => (gate = new Promise((r) => (open = r))),
      release: () => ((gate = null), open()),
    };
  }

  it('two quick checkbox mutes: the second PATCH holds both machines', async () => {
    orgStore.set({ loaded: true, orgs: [ORG] });
    pushStore.set({ [ORG.id]: { kind: 'row', state: { kind: 'active' }, device: device() } });
    const w = worker(true);
    w.hold();
    const a = mutePushMachine(ORG.id, MACHINE, true);
    await vi.waitFor(() => expect(patches()).toHaveLength(1));
    const b = mutePushMachine(ORG.id, OTHER, true);
    w.release();
    await Promise.all([a, b]);
    expect(patches().slice(0, 2)).toEqual([{ muted_machine_ids: [MACHINE] }, { muted_machine_ids: [MACHINE, OTHER] }]);
  });

  it("a notification's Mute and a checkbox mute queued behind it keep each other", async () => {
    orgStore.set({ loaded: true, orgs: [ORG] });
    machinesStore.set({ [ORG.id]: { state: 'ready', machines: [summary as MachineSummary], fetchedAt: 0 } });
    pushStore.set({ [ORG.id]: { kind: 'row', state: { kind: 'active' }, device: device() } });
    const w = worker(true);
    w.hold();
    await installPush();
    listeners.get('notificationTapped')!({ orgId: ORG.id, machineId: MACHINE, action: 'mute_machine' });
    await vi.waitFor(() => expect(patches()).toHaveLength(1));
    const b = mutePushMachine(ORG.id, OTHER, true);
    w.release();
    await b;
    expect(patches().slice(0, 2)).toEqual([{ muted_machine_ids: [MACHINE] }, { muted_machine_ids: [MACHINE, OTHER] }]);
  });

  it('a cold Mute with nothing cached and nothing to drain fetches the current device and mutes it', async () => {
    orgStore.set({ loaded: true, orgs: [ORG] });
    worker(true);
    vi.mocked(Push.setLocalMutes).mockClear();
    await installPush();
    listeners.get('notificationTapped')!({ orgId: ORG.id, machineId: MACHINE, action: 'mute_machine' });
    await vi.waitFor(() => expect(patches()).toEqual([{ muted_machine_ids: [MACHINE] }]));
    expect(Push.setLocalMutes).toHaveBeenCalledWith({ orgId: ORG.id, mutes: expect.objectContaining({ muted_machine_ids: [MACHINE] }) });
  });

  it('a cold Mute for a phone with no device row registers nothing and asks for nothing', async () => {
    orgStore.set({ loaded: true, orgs: [ORG] });
    worker(false);
    vi.mocked(Push.registerDevice).mockClear();
    vi.mocked(Push.requestPermission).mockClear();
    await installPush();
    listeners.get('notificationTapped')!({ orgId: ORG.id, machineId: MACHINE, action: 'mute_machine' });
    await vi.waitFor(() => expect(Session.request).toHaveBeenCalledWith(expect.objectContaining({ method: 'GET', path: '/v1/me/devices' })));
    await new Promise((r) => setTimeout(r, 10));
    expect(patches()).toEqual([]);
    expect(Push.registerDevice).not.toHaveBeenCalled();
    expect(Push.requestPermission).not.toHaveBeenCalled();
  });
});

describe('notification work ends with the push wiring that received it', () => {
  const summary = { id: MACHINE, name: 'box', hostname: 'box.example.com', url: 'https://box.example.com', status: 'online', status_checked_at: '2026-11-14T12:00:00Z', paired_at: '2026-11-14T12:00:00Z' };
  const LIST: ApiResult = { kind: 'ok', status: 200, body: { items: [summary], next_cursor: null } };

  it('removed while a cold tap waits on its refresh: nothing opens, nothing moves and the alert stays', async () => {
    orgStore.set({ loaded: true, orgs: [ORG] });
    location.hash = '#/settings';
    const remove = await installPush();
    const refresh = deferred<ApiResult>();
    vi.mocked(Session.request).mockImplementationOnce(() => refresh.promise);
    listeners.get('notificationTapped')!({ orgId: ORG.id, machineId: MACHINE, agentId: 'a1', action: 'open' });
    await vi.waitFor(() => expect(Session.request).toHaveBeenCalled());
    vi.mocked(MachineView.open).mockClear();
    vi.mocked(Push.clearDelivered).mockClear();
    remove();
    refresh.resolve(LIST);
    await new Promise((r) => setTimeout(r, 20));
    expect(MachineView.open).not.toHaveBeenCalled();
    expect(Push.clearDelivered).not.toHaveBeenCalled();
    // Not even the "no longer paired" fallback: the tap's handling ended with the wiring.
    expect(location.hash).toBe('#/settings');
  });

  it('removed while the native open is out: the alert is not cleared afterwards', async () => {
    orgStore.set({ loaded: true, orgs: [ORG] });
    machinesStore.set({ [ORG.id]: { state: 'ready', machines: [summary as MachineSummary], fetchedAt: 0 } });
    let mounted = true;
    await installPush(() => mounted);
    const opening = deferred<void>();
    vi.mocked(MachineView.open).mockImplementationOnce(() => opening.promise);
    vi.mocked(Push.clearDelivered).mockClear();
    listeners.get('notificationTapped')!({ orgId: ORG.id, machineId: MACHINE, agentId: 'a1', action: 'open' });
    await vi.waitFor(() => expect(MachineView.open).toHaveBeenCalled());
    mounted = false;
    opening.resolve();
    await new Promise((r) => setTimeout(r, 20));
    expect(Push.clearDelivered).not.toHaveBeenCalled();
  });

  it('torn down before its listeners finished registering: they are removed and nothing is drained', async () => {
    const removes: (() => Promise<void>)[] = [];
    vi.mocked(Push.addListener).mockImplementation((async (name: string, fn: (e: unknown) => void) => {
      listeners.set(name, fn);
      const remove = vi.fn(async () => {});
      removes.push(remove);
      return { remove };
    }) as never);
    vi.mocked(Push.drainPendingRegistrations).mockClear();
    await installPush(() => false);
    expect(removes).toHaveLength(3);
    for (const r of removes) expect(r).toHaveBeenCalled();
    expect(Push.drainPendingRegistrations).not.toHaveBeenCalled();
    vi.mocked(Push.addListener).mockImplementation((async (name: string, fn: (e: unknown) => void) => (listeners.set(name, fn), { remove: async () => {} })) as never);
  });
});
