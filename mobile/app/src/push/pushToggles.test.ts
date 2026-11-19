/**
 * Turn on and Turn off as the user's intent (round 12): each press takes the org's turn at once,
 * so the last press decides; a toggle the Worker has not confirmed stays owed, and the row's
 * Retry repeats it rather than checking again; a toggle that could not even be prepared says so.
 *
 * <module-headers:begin>
 * Uses:
 * src/push/pushToggles.test.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── @yaran/push:src/index.ts
 * ├── src/lib/machinesStore.ts
 * ├── src/lib/native/machineView.ts
 * ├── src/lib/orgStore.ts
 * ├── src/push/pushDeps.ts
 * ├── src/push/pushPermission.ts
 * ├── src/push/pushTestKit.ts
 * └── src/push/pushWiring.ts
 * External: sonner, vitest
 *
 * Used by: entry point (vitest, via npm test in mobile/app)
 * <module-headers:end>
 */
import type { Device } from '@yaran/protocol';
import { Push, type RegisterDeviceOptions, type RegisterDeviceResult } from '@yaran/push';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { machinesStore } from '../lib/machinesStore.ts';
import { Session, type ApiResult } from '../lib/native/machineView.ts';
import { addOrg, orgStore, removeOrgLocal } from '../lib/orgStore.ts';
import { muteSync, pushStore } from './pushDeps.ts';
import { rowView } from './pushPermission.ts';
import { pushAction, reconcilePush, turnOffPush } from './pushWiring.ts';
import { device, listing, VAPID } from './pushTestKit.ts';

vi.mock('@yaran/push', async (orig) => ({
  ...(await orig<typeof import('@yaran/push')>()),
  Push: {
    addListener: vi.fn(async () => ({ remove: async () => {} })),
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
const ABSENT = { ...HEALTHY, subscribed: false, endpointHost: null, vapidPublicKey: null };
const tick = () => new Promise((r) => setTimeout(r, 0));
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** The Worker's device per org; a registration replaces its push (none when `pushOff`) and mutes. */
let server: Record<string, Device>;
let registerAnswer: ((o: RegisterDeviceOptions) => RegisterDeviceResult) | null;
const offs = () => vi.mocked(Push.registerDevice).mock.calls.map((c) => c[0].pushOff);
const row = (id: string) => pushStore.get()[id];
const org = () => orgStore.get().orgs.find((o) => o.id === ORG.id)!;
/** Presses whatever the row shows, as the Settings section does. */
async function pressRowAction(id: string) {
  const r = row(id);
  if (r?.kind !== 'row') throw new Error('no row');
  const action = rowView(r.state).action;
  expect(action).toBe('retry');
  await pushAction(id, action!);
}

beforeEach(async () => {
  server = { [ORG.id]: device(), [ORG_B.id]: device({ id: 'b0ffee00-1234-4abc-bdef-0123456789ab' }) };
  registerAnswer = null;
  vi.mocked(Session.meta).mockReset().mockResolvedValue(META);
  vi.mocked(Push.localState).mockReset().mockResolvedValue(HEALTHY as never);
  vi.mocked(Push.registerDevice).mockReset().mockImplementation(async (o) => {
    if (registerAnswer) return registerAnswer(o);
    const next = { ...server[o.orgId]!, ...o.mutes, ...(o.pushOff ? { push: { kind: 'none' as const }, push_state: 'none' as const } : { push: device().push, push_state: 'active' as const }) };
    server[o.orgId] = next as Device;
    return { outcome: 'ok', device: next as Device };
  });
  vi.mocked(Session.request).mockReset().mockImplementation(async ({ orgId, method }): Promise<ApiResult> => (method === 'GET' ? listing(server[orgId]!) : { kind: 'offline' }));
  for (const t of Object.values(toast)) vi.mocked(t).mockClear();
  await addOrg(ORG);
});

afterEach(() => {
  pushStore.set({});
  machinesStore.set({});
  muteSync.forget();
  orgStore.set({ loaded: true, orgs: [] });
});

describe("a failed Turn off is retried as a Turn off", () => {
  async function offFailsOffline() {
    registerAnswer = () => ({ outcome: 'offline' });
    await turnOffPush(org());
    expect(row(ORG.id)).toMatchObject({ kind: 'row', state: { kind: 'registration_failed' } });
    expect(toast.error).toHaveBeenCalledTimes(1);
    registerAnswer = null;
    vi.mocked(Push.registerDevice).mockClear();
  }

  for (const [name, local] of [['absent', ABSENT], ['healthy', HEALTHY]] as const) {
    it(`Retry with the subscription ${name}: the next registration is pushOff true and the row says off`, async () => {
      await offFailsOffline();
      vi.mocked(Push.localState).mockResolvedValue(local as never);
      await pressRowAction(ORG.id);
      expect(offs()).toEqual([true]);
      expect(server[ORG.id]!.push.kind).toBe('none');
      expect(row(ORG.id)).toMatchObject({ kind: 'row', state: { kind: 'turned_off' } });
      expect(toast.success).toHaveBeenCalledTimes(1);
    });
  }

  it('a resume reconcile after it, with the subscription gone, retries the off rather than turning push on', async () => {
    await offFailsOffline();
    vi.mocked(Push.localState).mockResolvedValue(ABSENT as never);
    await reconcilePush(org());
    expect(offs()).toEqual([true]);
    expect(row(ORG.id)).toMatchObject({ kind: 'row', state: { kind: 'turned_off' } });
  });

  it('the org removed and added again: Retry on the new one checks it again and turns nothing off', async () => {
    await offFailsOffline();
    await removeOrgLocal(ORG.id);
    await addOrg(ORG);
    pushStore.set({ [ORG.id]: { kind: 'row', state: { kind: 'registration_failed', reason: 'x' }, device: null } });
    await pressRowAction(ORG.id);
    expect(offs()).toEqual([]);
    expect(row(ORG.id)).toMatchObject({ kind: 'row', state: { kind: 'active' } });
  });
});

describe('the last press decides', () => {
  it('Off A held at its metadata, then Off B and On C: B and C wait, and the end state is on', async () => {
    const meta = deferred<typeof META>();
    vi.mocked(Session.meta).mockImplementationOnce(() => meta.promise);
    const a = turnOffPush(org());
    await vi.waitFor(() => expect(Session.meta).toHaveBeenCalled());
    const b = turnOffPush(org());
    const c = pushAction(ORG.id, 'turn_on');
    await tick();
    expect(Push.registerDevice).not.toHaveBeenCalled();
    meta.resolve(META);
    await Promise.all([a, b, c]);
    expect(offs()).toEqual([true, true, false]);
    expect(server[ORG.id]!.push.kind).toBe('webpush');
    expect(row(ORG.id)).toMatchObject({ kind: 'row', state: { kind: 'active' } });
  });

  it('On A held at its permission prompt, then Off B: B waits, and the end state is off', async () => {
    const asked = deferred<{ notifications: 'granted' }>();
    vi.mocked(Push.checkPermission).mockResolvedValueOnce({ notifications: 'prompt' } as never);
    vi.mocked(Push.requestPermission).mockImplementationOnce(() => asked.promise as never);
    const a = pushAction(ORG.id, 'turn_on');
    await vi.waitFor(() => expect(Push.requestPermission).toHaveBeenCalled());
    const b = turnOffPush(org());
    await tick();
    expect(Push.registerDevice).not.toHaveBeenCalled();
    asked.resolve({ notifications: 'granted' });
    await Promise.all([a, b]);
    expect(offs()).toEqual([false, true]);
    expect(row(ORG.id)).toMatchObject({ kind: 'row', state: { kind: 'turned_off' } });
  });

  it("one org's held Turn off does not hold up another org's", async () => {
    await addOrg(ORG_B);
    const meta = deferred<typeof META>();
    vi.mocked(Session.meta).mockImplementationOnce(() => meta.promise);
    const a = turnOffPush(org());
    await vi.waitFor(() => expect(Session.meta).toHaveBeenCalled());
    await turnOffPush(orgStore.get().orgs.find((o) => o.id === ORG_B.id)!);
    expect(row(ORG_B.id)).toMatchObject({ kind: 'row', state: { kind: 'turned_off' } });
    meta.resolve(META);
    await a;
  });
});

describe('a toggle that could not be prepared says so', () => {
  it('Turn off with the metadata offline: a failure row and toast, no registration, and Retry turns it off', async () => {
    vi.mocked(Session.meta).mockResolvedValueOnce({ kind: 'offline' });
    await turnOffPush(org());
    expect(Push.registerDevice).not.toHaveBeenCalled();
    expect(row(ORG.id)).toMatchObject({ kind: 'row', state: { kind: 'registration_failed', reason: 'this phone is offline' } });
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.success).not.toHaveBeenCalled();
    await pressRowAction(ORG.id);
    expect(offs()).toEqual([true]);
    expect(row(ORG.id)).toMatchObject({ kind: 'row', state: { kind: 'turned_off' } });
  });

  it('Turn on whose install id is refused natively: the sanitized code on the row and a failure toast', async () => {
    vi.mocked(Session.installId).mockRejectedValueOnce(Object.assign(new Error('nope\u0007'), { code: 'native_error' }));
    await pushAction(ORG.id, 'turn_on');
    expect(Push.registerDevice).not.toHaveBeenCalled();
    expect(row(ORG.id)).toMatchObject({ kind: 'row', state: { kind: 'registration_failed', reason: 'the request did not complete (native_error)' } });
    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it('a preparation that fails after the org was removed says nothing and records nothing', async () => {
    const meta = deferred<ApiResult>();
    vi.mocked(Session.meta).mockImplementationOnce(() => meta.promise as never);
    const off = turnOffPush(org());
    await vi.waitFor(() => expect(Session.meta).toHaveBeenCalled());
    await removeOrgLocal(ORG.id);
    meta.resolve({ kind: 'offline' });
    await off;
    expect(row(ORG.id)).toBeUndefined();
    expect(toast.error).not.toHaveBeenCalled();
    expect(Push.registerDevice).not.toHaveBeenCalled();
  });
});

describe('a registration that rejects instead of answering is a failure said on the row', () => {
  const unavailable = () => Object.assign(new Error('push service gone'), { code: 'unavailable' });

  it('Turn off rejected natively: failure row and toast, then the displayed Retry turns it off', async () => {
    vi.mocked(Push.registerDevice).mockRejectedValueOnce(unavailable());
    await turnOffPush(org());
    expect(row(ORG.id)).toMatchObject({ kind: 'row', state: { kind: 'registration_failed', reason: 'the request did not complete (unavailable)' } });
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.success).not.toHaveBeenCalled();
    await pressRowAction(ORG.id);
    expect(offs()).toEqual([true, true]);
    expect(row(ORG.id)).toMatchObject({ kind: 'row', state: { kind: 'turned_off' } });
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it('Turn on rejected natively: failure row and toast, not a silent log', async () => {
    vi.mocked(Push.registerDevice).mockRejectedValueOnce(unavailable());
    await pushAction(ORG.id, 'turn_on');
    expect(row(ORG.id)).toMatchObject({ kind: 'row', state: { kind: 'registration_failed' } });
    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it('a rejection after the org was removed records nothing and says nothing', async () => {
    let reject!: (e: unknown) => void;
    vi.mocked(Push.registerDevice).mockImplementationOnce(() => new Promise((_, r) => (reject = r)));
    const off = turnOffPush(org());
    await vi.waitFor(() => expect(Push.registerDevice).toHaveBeenCalled());
    await removeOrgLocal(ORG.id);
    reject(unavailable());
    await off;
    expect(row(ORG.id)).toBeUndefined();
    expect(toast.error).not.toHaveBeenCalled();
  });
});
