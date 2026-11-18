/**
 * A user's push action whose native or org call THROWS rather than answers (round 14): a mute
 * whose lookup or PATCH rejects restores the mirror, keeps what was owed and says it failed; a
 * Turn on whose permission step rejects says so on the row and stays owed for Retry; a throw for
 * an org gone since says and changes nothing. A deliberate permission denial is not a failure.
 *
 * <module-headers:begin>
 * Uses:
 * src/push/pushRejections.test.ts
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
import { installPush, mutePushMachine, mutePushOrg, pushAction } from './pushWiring.ts';
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
    openNotificationSettings: vi.fn(async () => {}),
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

/** The Worker's device per org; a registration replaces its push (none when `pushOff`) and mutes. */
let server: Record<string, Device>;
let registerAnswer: ((o: RegisterDeviceOptions) => RegisterDeviceResult) | null;
const offs = () => vi.mocked(Push.registerDevice).mock.calls.map((c) => c[0].pushOff);
const row = (id: string) => pushStore.get()[id];
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

const boom = () => Object.assign(new Error('native gone'), { code: 'unavailable' });
const lastMirror = () => vi.mocked(Push.setLocalMutes).mock.calls.at(-1)?.[0].mutes;
const patchBodies = () => vi.mocked(Session.request).mock.calls.filter((c) => c[0].method === 'PATCH').map((c) => c[0].body);
/** Answers the next request of `method` with a rejection, everything else as the Worker does. */
function rejectNext(method: 'GET' | 'PATCH', hold?: Promise<void>) {
  const real = vi.mocked(Session.request).getMockImplementation()!;
  let used = false;
  vi.mocked(Session.request).mockImplementation(async (o) => {
    if (o.method !== method || used) return real(o);
    used = true;
    if (hold) await hold;
    throw boom();
  });
}

describe('a mute whose request throws', () => {
  beforeEach(() => {
    pushStore.set({ [ORG.id]: { kind: 'row', state: { kind: 'active' }, device: device() } });
    vi.mocked(Push.setLocalMutes).mockClear();
  });

  it('Settings: an earlier offline mute stays owed, the mirror goes back to it, and the failure is said', async () => {
    // Mute forever while offline: owed, and enforced locally.
    const real = vi.mocked(Session.request).getMockImplementation()!;
    vi.mocked(Session.request).mockImplementation(async (o) => (o.method === 'PATCH' ? { kind: 'offline' } : real(o)));
    await mutePushOrg(ORG.id, 'forever');
    vi.mocked(Session.request).mockImplementation(real);
    rejectNext('PATCH');
    for (const t of Object.values(toast)) vi.mocked(t).mockClear();
    await mutePushMachine(ORG.id, MACHINE, true);
    expect(lastMirror()).toEqual({ mute_all: true, muted_until: null, muted_machine_ids: [] });
    expect(muteSync.hasPending(ORG.id)).toBe(true);
    expect(toast.error).toHaveBeenCalledTimes(1);
    // The owed field still reaches the Worker with the next change.
    await mutePushMachine(ORG.id, MACHINE, true);
    expect(patchBodies().at(-1)).toEqual({ mute_all: true, muted_machine_ids: [MACHINE] });
  });

  it("a notification's Mute whose PATCH throws restores the mirror and says it failed", async () => {
    machinesStore.set({ [ORG.id]: { state: 'ready', machines: [{ id: MACHINE, name: 'box' }] as never, fetchedAt: 0 } });
    rejectNext('PATCH');
    await installPush();
    listeners.get('notificationTapped')!({ orgId: ORG.id, machineId: MACHINE, action: 'mute_machine' });
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect(lastMirror()).toEqual({ mute_all: false, muted_until: null, muted_machine_ids: [] });
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('a cold lookup that throws sends nothing, mirrors nothing, and says it failed', async () => {
    pushStore.set({});
    rejectNext('GET');
    await mutePushMachine(ORG.id, MACHINE, true);
    expect(patchBodies()).toEqual([]);
    // The reconcile after it may mirror what is in force; nothing ever enforces the failed mute.
    expect(vi.mocked(Push.setLocalMutes).mock.calls.every((c) => !c[0].mutes.muted_machine_ids.includes(MACHINE))).toBe(true);
    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it('a PATCH that throws after the org was removed and added again changes nothing of the new one', async () => {
    let open!: () => void;
    rejectNext('PATCH', new Promise<void>((r) => (open = r)));
    const mute = mutePushMachine(ORG.id, MACHINE, true);
    await vi.waitFor(() => expect(patchBodies()).toHaveLength(1));
    await removeOrgLocal(ORG.id);
    await addOrg(ORG);
    vi.mocked(Push.setLocalMutes).mockClear();
    open();
    await mute;
    expect(Push.setLocalMutes).not.toHaveBeenCalled();
    expect(muteSync.hasPending(ORG.id)).toBe(false);
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe('a Turn on whose permission step throws', () => {
  for (const step of ['checkPermission', 'requestPermission'] as const) {
    it(`${step} rejects: a failure row and toast, On stays owed, and the displayed Retry turns it on`, async () => {
      if (step === 'checkPermission') vi.mocked(Push.checkPermission).mockRejectedValueOnce(boom());
      else {
        vi.mocked(Push.checkPermission).mockResolvedValueOnce({ notifications: 'prompt' } as never);
        vi.mocked(Push.requestPermission).mockRejectedValueOnce(boom());
      }
      pushStore.set({ [ORG.id]: { kind: 'row', state: { kind: 'turned_off' }, device: device({ push: { kind: 'none' }, push_state: 'none' } as never) } });
      await pushAction(ORG.id, 'turn_on');
      expect(Push.registerDevice).not.toHaveBeenCalled();
      expect(row(ORG.id)).toMatchObject({ kind: 'row', state: { kind: 'registration_failed', reason: 'the request did not complete (unavailable)' } });
      expect(toast.error).toHaveBeenCalledTimes(1);
      expect(muteSync.owedToggle(ORG.id)).toBe(false);
      await pressRowAction(ORG.id);
      expect(offs()).toEqual([false]);
      expect(row(ORG.id)).toMatchObject({ kind: 'row', state: { kind: 'active' } });
    });
  }

  it('a rejection after the org was removed records and says nothing', async () => {
    let reject!: (e: unknown) => void;
    vi.mocked(Push.checkPermission).mockResolvedValueOnce({ notifications: 'prompt' } as never);
    vi.mocked(Push.requestPermission).mockImplementationOnce(() => new Promise((_, r) => (reject = r)) as never);
    const on = pushAction(ORG.id, 'turn_on');
    await vi.waitFor(() => expect(Push.requestPermission).toHaveBeenCalled());
    await removeOrgLocal(ORG.id);
    reject(boom());
    await on;
    expect(row(ORG.id)).toBeUndefined();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('control: a deliberate denial is not a failure and owes nothing', async () => {
    vi.mocked(Push.checkPermission).mockResolvedValueOnce({ notifications: 'prompt' } as never);
    vi.mocked(Push.requestPermission).mockResolvedValueOnce({ notifications: 'denied' } as never);
    await pushAction(ORG.id, 'turn_on');
    expect(Push.registerDevice).not.toHaveBeenCalled();
    expect(row(ORG.id)).toBeUndefined();
    expect(toast.error).not.toHaveBeenCalled();
    expect(muteSync.owedToggle(ORG.id)).toBeUndefined();
  });
});
