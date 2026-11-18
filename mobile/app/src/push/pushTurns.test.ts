/**
 * Push decisions through the org's one turn (round 10): a reconcile decided from an earlier
 * snapshot never undoes a Turn off, a revocation found by a mute removes the org it was found
 * for (and only that one), and Turn off is announced only once it is confirmed.
 *
 * <module-headers:begin>
 * Uses:
 * src/push/pushTurns.test.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── @yaran/push:src/index.ts
 * ├── @yaran/secure-store:src/index.ts
 * ├── src/lib/machinesStore.ts
 * ├── src/lib/native/machineView.ts
 * ├── src/lib/orgStore.ts
 * ├── src/push/pushDeps.ts
 * ├── src/push/pushTestKit.ts
 * └── src/push/pushWiring.ts
 * External: sonner, vitest
 *
 * Used by: entry point (vitest, via npm test in mobile/app)
 * <module-headers:end>
 */
import type { Device } from '@yaran/protocol';
import { Push, type RegisterDeviceOptions, type RegisterDeviceResult } from '@yaran/push';
import { SecureStore } from '@yaran/secure-store';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { machinesStore } from '../lib/machinesStore.ts';
import { Session, type ApiResult } from '../lib/native/machineView.ts';
import { addOrg, orgStore, removeOrgLocal } from '../lib/orgStore.ts';
import { muteSync, pushStore } from './pushDeps.ts';
import { installPush, mutePushMachine, pushAction, reconcilePush, turnOffPush } from './pushWiring.ts';
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
    registerDevice: vi.fn(),
    setLocalMutes: vi.fn(async () => {}),
    localState: vi.fn(),
  },
}));
vi.mock('sonner', async (orig) => ({
  ...(await orig<typeof import('sonner')>()),
  toast: { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn(), loading: vi.fn() },
}));

const ORG = { id: 'https://cp.example.com', name: 'Ada', teamDomain: null };
const ORG_B = { id: 'https://cp2.example.com', name: 'Babbage', teamDomain: null };
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
const HEALTHY = { subscribed: true, channel: 'unifiedpush', endpointHost: 'ntfy.example.com', vapidPublicKey: VAPID, relayKeyId: null, relayKeyCurrent: null };
const tick = () => new Promise((r) => setTimeout(r, 0));
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/**
 * The Worker's device per org: GET lists it, a PATCH merges into it, and a registration
 * replaces its push (none when `pushOff`) and mutes. `answer` overrides one registration.
 */
let server: Record<string, Device>;
let registerAnswer: ((o: RegisterDeviceOptions) => RegisterDeviceResult | Promise<RegisterDeviceResult>) | null;
const offs = () => vi.mocked(Push.registerDevice).mock.calls.map((c) => c[0].pushOff);
const patches = () => vi.mocked(Session.request).mock.calls.filter((c) => c[0].method === 'PATCH');
const row = (id: string) => pushStore.get()[id];

beforeEach(async () => {
  server = { [ORG.id]: device(), [ORG_B.id]: device({ id: 'b0ffee00-1234-4abc-bdef-0123456789ab' }) };
  registerAnswer = null;
  vi.mocked(Session.meta).mockResolvedValue(META);
  vi.mocked(Push.localState).mockResolvedValue(HEALTHY as never);
  vi.mocked(Push.registerDevice).mockReset().mockImplementation(async (o) => {
    if (registerAnswer) return registerAnswer(o);
    const next = { ...server[o.orgId]!, ...o.mutes, ...(o.pushOff ? { push: { kind: 'none' as const }, push_state: 'none' as const } : { push: device().push, push_state: 'active' as const }) };
    server[o.orgId] = next as Device;
    return { outcome: 'ok', device: next as Device };
  });
  vi.mocked(Session.request).mockReset().mockImplementation(async ({ orgId, method, body }): Promise<ApiResult> => {
    if (method === 'GET') return listing(server[orgId]!);
    server[orgId] = { ...server[orgId]!, ...(body as object) };
    return { kind: 'ok', status: 200, body: server[orgId] };
  });
  vi.mocked(Push.forgetOrg).mockClear();
  for (const t of Object.values(toast)) vi.mocked(t).mockClear();
  await addOrg(ORG);
});

afterEach(async () => {
  pushStore.set({});
  machinesStore.set({});
  muteSync.forget();
  orgStore.set({ loaded: true, orgs: [] });
});

describe('a reconcile decided from an earlier snapshot never undoes a Turn off', () => {
  it('reconcile held at its local state (stale), Turn off pressed: Turn off waits, then wins; the row says off', async () => {
    const local = deferred<unknown>();
    vi.mocked(Push.localState).mockImplementationOnce(() => local.promise as never);
    const reconcile = reconcilePush(orgStore.get().orgs[0]!);
    await vi.waitFor(() => expect(Push.localState).toHaveBeenCalled());
    const off = turnOffPush(orgStore.get().orgs[0]!);
    await tick();
    expect(Push.registerDevice).not.toHaveBeenCalled();
    local.resolve({});
    await Promise.all([reconcile, off]);
    expect(offs()).toEqual([false, true]);
    expect(server[ORG.id]!.push.kind).toBe('none');
    expect(row(ORG.id)).toMatchObject({ kind: 'row', state: { kind: 'turned_off' } });
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it('reconcile held at its local state (healthy), Turn off pressed: active is published first, off last', async () => {
    const local = deferred<unknown>();
    vi.mocked(Push.localState).mockImplementationOnce(() => local.promise as never);
    const seen: string[] = [];
    const stop = pushStore.subscribe(() => {
      const r = pushStore.get()[ORG.id];
      if (r?.kind === 'row') seen.push(r.state.kind);
    });
    const reconcile = reconcilePush(orgStore.get().orgs[0]!);
    await vi.waitFor(() => expect(Push.localState).toHaveBeenCalled());
    const off = turnOffPush(orgStore.get().orgs[0]!);
    local.resolve(HEALTHY);
    await Promise.all([reconcile, off]);
    stop();
    expect(offs()).toEqual([true]);
    expect(seen).toEqual(['active', 'turned_off']);
  });

  it('Turn off held at its registration, a reconcile queued behind it: the reconcile lists the off device and keeps it off', async () => {
    const reg = deferred<void>();
    registerAnswer = async (o) => {
      await reg.promise;
      registerAnswer = null;
      return (vi.mocked(Push.registerDevice).getMockImplementation()!)(o);
    };
    const off = turnOffPush(orgStore.get().orgs[0]!);
    await vi.waitFor(() => expect(Push.registerDevice).toHaveBeenCalled());
    const reconcile = reconcilePush(orgStore.get().orgs[0]!);
    await tick();
    expect(Push.localState).not.toHaveBeenCalled();
    reg.resolve();
    await Promise.all([off, reconcile]);
    expect(offs()).toEqual([true]);
    expect(row(ORG.id)).toMatchObject({ kind: 'row', state: { kind: 'turned_off' } });
  });

  it('Turn on held at its registration, Turn off pressed: Turn off runs after it and the end state is off', async () => {
    const reg = deferred<void>();
    registerAnswer = async (o) => {
      await reg.promise;
      registerAnswer = null;
      return (vi.mocked(Push.registerDevice).getMockImplementation()!)(o);
    };
    const on = pushAction(ORG.id, 'turn_on');
    await vi.waitFor(() => expect(Push.registerDevice).toHaveBeenCalled());
    const off = turnOffPush(orgStore.get().orgs[0]!);
    await tick();
    expect(offs()).toEqual([false]);
    reg.resolve();
    await Promise.all([on, off]);
    expect(offs()).toEqual([false, true]);
    expect(row(ORG.id)).toMatchObject({ kind: 'row', state: { kind: 'turned_off' } });
  });

  it('a revocation is recorded in its turn: a Turn off queued behind it finds the org gone and registers nothing', async () => {
    vi.mocked(Session.request).mockResolvedValue({ kind: 'device_revoked' });
    const real = vi.mocked(SecureStore.set).getMockImplementation()!;
    const gate = deferred<void>();
    vi.mocked(SecureStore.set).mockImplementation(async (o) => (await gate.promise, real(o)));
    vi.mocked(SecureStore.set).mockClear();
    const reconcile = reconcilePush(orgStore.get().orgs[0]!);
    // The org's removal is under way, its list write held.
    await vi.waitFor(() => expect(SecureStore.set).toHaveBeenCalled());
    const off = turnOffPush(orgStore.get().orgs[0]!);
    await tick();
    gate.resolve();
    vi.mocked(SecureStore.set).mockImplementation(real);
    await Promise.all([reconcile, off]);
    expect(Push.registerDevice).not.toHaveBeenCalled();
    expect(orgStore.get().orgs).toEqual([]);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('one org held in its turn does not hold up another org in the same drain', async () => {
    await addOrg(ORG_B);
    const local = deferred<unknown>();
    vi.mocked(Push.localState).mockImplementation(async ({ orgId }) => (orgId === ORG.id ? (local.promise as never) : (HEALTHY as never)));
    vi.mocked(Push.drainPendingRegistrations).mockResolvedValueOnce({ orgIds: [ORG.id, ORG_B.id] });
    await installPush();
    await vi.waitFor(() => expect(row(ORG_B.id)).toMatchObject({ kind: 'row', state: { kind: 'active' } }));
    expect(row(ORG.id)).toBeUndefined();
    local.resolve(HEALTHY);
    await vi.waitFor(() => expect(row(ORG.id)).toMatchObject({ kind: 'row', state: { kind: 'active' } }));
  });
});

describe('a revocation a mute finds removes the org it was found for', () => {
  const removed = () => expect(orgStore.get().orgs.map((o) => o.id)).not.toContain(ORG.id);

  it('cold lookup answered device_revoked: the org and its push keys go, and no PATCH is sent', async () => {
    vi.mocked(Session.request).mockResolvedValue({ kind: 'device_revoked' });
    await mutePushMachine(ORG.id, MACHINE, true);
    await vi.waitFor(removed);
    expect(Push.forgetOrg).toHaveBeenCalledWith({ orgId: ORG.id });
    expect(patches()).toEqual([]);
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('cached device, PATCH answered device_revoked: the org and its push keys go', async () => {
    pushStore.set({ [ORG.id]: { kind: 'row', state: { kind: 'active' }, device: device() } });
    vi.mocked(Session.request).mockResolvedValue({ kind: 'device_revoked' });
    await mutePushMachine(ORG.id, MACHINE, true);
    await vi.waitFor(removed);
    expect(Push.forgetOrg).toHaveBeenCalledWith({ orgId: ORG.id });
    expect(toast.warning).toHaveBeenCalledTimes(1);
    // Said as the removal it is, never as a generic failure.
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("a notification's Mute answered device_revoked removes the org the same way", async () => {
    machinesStore.set({ [ORG.id]: { state: 'ready', machines: [{ id: MACHINE, name: 'box' }] as never, fetchedAt: 0 } });
    pushStore.set({ [ORG.id]: { kind: 'row', state: { kind: 'active' }, device: device() } });
    vi.mocked(Session.request).mockResolvedValue({ kind: 'device_revoked' });
    await installPush();
    listeners.get('notificationTapped')!({ orgId: ORG.id, machineId: MACHINE, action: 'mute_machine' });
    await vi.waitFor(removed);
    expect(Push.forgetOrg).toHaveBeenCalledWith({ orgId: ORG.id });
  });

  it('an old incarnation revoked after the org was removed and added again leaves the new one alone', async () => {
    pushStore.set({ [ORG.id]: { kind: 'row', state: { kind: 'active' }, device: device() } });
    const answer = deferred<ApiResult>();
    vi.mocked(Session.request).mockImplementationOnce(() => answer.promise);
    const mute = mutePushMachine(ORG.id, MACHINE, true);
    await vi.waitFor(() => expect(patches()).toHaveLength(1));
    await removeOrgLocal(ORG.id);
    await addOrg(ORG);
    answer.resolve({ kind: 'device_revoked' });
    await mute;
    await tick();
    expect(orgStore.get().orgs.map((o) => o.id)).toEqual([ORG.id]);
    expect(Push.forgetOrg).not.toHaveBeenCalled();
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('a cold lookup answered session_expired is not a revocation: the org stays and the failure is said', async () => {
    vi.mocked(Session.request).mockResolvedValue({ kind: 'session_expired' });
    await mutePushMachine(ORG.id, MACHINE, true);
    expect(orgStore.get().orgs.map((o) => o.id)).toEqual([ORG.id]);
    expect(Push.forgetOrg).not.toHaveBeenCalled();
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledTimes(1);
  });
});

describe('Turn off is announced only once it is confirmed', () => {
  const failures: [string, RegisterDeviceResult][] = [
    ['offline', { outcome: 'offline' }],
    ['session_expired', { outcome: 'session_expired' }],
    ['api_error', { outcome: 'api_error', code: 'conflict' } as RegisterDeviceResult],
  ];
  for (const [name, answer] of failures) {
    it(`${name}: no off-success, a failure toast, and the row says registration failed`, async () => {
      registerAnswer = () => answer;
      await turnOffPush(orgStore.get().orgs[0]!);
      expect(toast.success).not.toHaveBeenCalled();
      expect(toast.error).toHaveBeenCalledTimes(1);
      expect(row(ORG.id)).toMatchObject({ kind: 'row', state: { kind: 'registration_failed' } });
    });
  }

  it('control: a confirmed off is announced', async () => {
    await turnOffPush(orgStore.get().orgs[0]!);
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(toast.error).not.toHaveBeenCalled();
    expect(row(ORG.id)).toMatchObject({ kind: 'row', state: { kind: 'turned_off' } });
  });
});

describe("a cold notification's Mute takes the org's turn before its device lookup", () => {
  it('lookup held, a reconcile and an unmute of the same machine pressed after: the unmute lands last', async () => {
    const real = vi.mocked(Session.request).getMockImplementation()!;
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    vi.mocked(Session.request).mockImplementationOnce(async (o) => (await gate, real(o)));
    vi.mocked(Push.setLocalMutes).mockClear();
    // The list is loaded, so the first request is the cold device lookup, held.
    machinesStore.set({ [ORG.id]: { state: 'ready', machines: [{ id: MACHINE, name: 'box' }] as never, fetchedAt: 0 } });
    await installPush();
    listeners.get('notificationTapped')!({ orgId: ORG.id, machineId: MACHINE, action: 'mute_machine' });
    await vi.waitFor(() => expect(Session.request).toHaveBeenCalledWith(expect.objectContaining({ method: 'GET', path: '/v1/me/devices' })));
    const reconcile = reconcilePush(orgStore.get().orgs[0]!);
    const unmute = mutePushMachine(ORG.id, MACHINE, false);
    await new Promise((r) => setTimeout(r, 10));
    expect(vi.mocked(Session.request).mock.calls.filter((c) => c[0].method === 'PATCH')).toEqual([]);
    open();
    await Promise.all([reconcile, unmute]);
    await vi.waitFor(() => expect(patches().map((c) => c[0].body)).toEqual([{ muted_machine_ids: [MACHINE] }, { muted_machine_ids: [] }]));
    expect(server[ORG.id]!.muted_machine_ids).toEqual([]);
    expect(vi.mocked(Push.setLocalMutes).mock.calls.at(-1)![0].mutes.muted_machine_ids).toEqual([]);
    expect(Push.registerDevice).not.toHaveBeenCalled();
    expect(Push.requestPermission).not.toHaveBeenCalled();
  });

  it('Settings: a mute whose cold lookup is held, then an unmute of the same machine: the unmute lands last', async () => {
    const real = vi.mocked(Session.request).getMockImplementation()!;
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    vi.mocked(Session.request).mockImplementationOnce(async (o) => (await gate, real(o)));
    const mute = mutePushMachine(ORG.id, MACHINE, true);
    await vi.waitFor(() => expect(Session.request).toHaveBeenCalledWith(expect.objectContaining({ method: 'GET', path: '/v1/me/devices' })));
    const unmute = mutePushMachine(ORG.id, MACHINE, false);
    await new Promise((r) => setTimeout(r, 10));
    open();
    await Promise.all([mute, unmute]);
    expect(patches().map((c) => c[0].body)).toEqual([{ muted_machine_ids: [MACHINE] }, { muted_machine_ids: [] }]);
    expect(server[ORG.id]!.muted_machine_ids).toEqual([]);
  });
});
