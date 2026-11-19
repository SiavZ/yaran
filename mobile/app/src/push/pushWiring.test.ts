/**
 * Tests for the push wiring: sign-out unregisters the device row first, and a notification
 * tap opens only a machine from the authenticated list.
 *
 * <module-headers:begin>
 * Uses:
 * src/push/pushWiring.test.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── @yaran/push:src/index.ts
 * ├── @yaran/secure-store:src/index.ts
 * ├── src/lib/machinesStore.ts
 * ├── src/lib/native/machineView.ts
 * ├── src/lib/orgStore.ts
 * ├── src/lib/route.ts
 * ├── src/lib/settingsStore.ts
 * ├── src/push/pushDeps.ts
 * ├── src/push/pushTestKit.ts
 * ├── src/push/pushWiring.ts
 * └── src/screens/machines/MachineList.tsx
 * External: sonner, vitest
 *
 * Used by: entry point (vitest, via npm test in mobile/app)
 * <module-headers:end>
 */
import type { MachineSummary } from '@yaran/protocol';
import { Push } from '@yaran/push';
import { toast } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { machinesStore } from '../lib/machinesStore.ts';
import { MachineView, Session, type ApiResult } from '../lib/native/machineView.ts';
import { addOrg, eraseEverything, orgIncarnation, orgStore, signOutOrg } from '../lib/orgStore.ts';
import { parseRoute } from '../lib/route.ts';
import { DEFAULT_SETTINGS, settingsStore } from '../lib/settingsStore.ts';
import { onOrgFailure } from '../screens/machines/MachineList.tsx';
import { SecureStore } from '@yaran/secure-store';
import { pushStore, scopedPushDeps } from './pushDeps.ts';
import { installPush, mutePushOrg, pushAction, reconcilePush, turnOffPush } from './pushWiring.ts';
import { device, MACHINE, VAPID } from './pushTestKit.ts';

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

vi.mock('sonner', async (orig) => ({
  ...(await orig<typeof import('sonner')>()),
  toast: { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn(), loading: vi.fn() },
}));

const ORG = { id: 'https://cp.example.com', name: 'Ada', teamDomain: null, addedAt: 'x' };

afterEach(() => {
  pushStore.set({});
  machinesStore.set({});
  orgStore.set({ loaded: true, orgs: [] });
});

describe('push wiring', () => {
  it('sends W14 for the device row before signing out of the org', async () => {
    orgStore.set({ loaded: true, orgs: [ORG] });
    pushStore.set({ [ORG.id]: { kind: 'row', state: { kind: 'active' }, device: device() } });
    const order: string[] = [];
    vi.mocked(Session.request).mockImplementation(async (o) => (order.push(`${o.method} ${o.path}`), { kind: 'ok', status: 204, body: null }));
    vi.mocked(Session.signOut).mockImplementation(async () => void order.push('signOut'));
    await signOutOrg(ORG.id);
    expect(order).toEqual([`DELETE /v1/me/devices/${device().id}`, 'signOut']);
    expect(pushStore.get()).toEqual({});
  });

  it('opens a tapped machine from the authenticated list and nothing else', async () => {
    orgStore.set({ loaded: true, orgs: [ORG] });
    machinesStore.set({ [ORG.id]: { state: 'ready', machines: [{ id: MACHINE, name: 'box', hostname: 'box.example.com' } as MachineSummary], fetchedAt: 0 } });
    await installPush();
    const tap = listeners.get('notificationTapped')!;
    tap({ orgId: ORG.id, machineId: MACHINE, agentId: 'a1', action: 'open' });
    await vi.waitFor(() => expect(MachineView.open).toHaveBeenCalledWith({ orgId: ORG.id, machineId: MACHINE, host: 'box.example.com', route: '#/agent/a1' }));
    vi.mocked(MachineView.open).mockClear();
    tap({ orgId: ORG.id, machineId: '11111111-1111-4111-8111-111111111111', agentId: 'a1', action: 'open' });
    await new Promise((r) => setTimeout(r, 10));
    expect(MachineView.open).not.toHaveBeenCalled();
  });

  it('a native refusal from the tap says why and keeps the alert, a later success clears it', async () => {
    orgStore.set({ loaded: true, orgs: [ORG] });
    machinesStore.set({ [ORG.id]: { state: 'ready', machines: [{ id: MACHINE, name: 'box', hostname: 'box.example.com' } as MachineSummary], fetchedAt: 0 } });
    await installPush();
    const tap = listeners.get('notificationTapped')!;
    vi.mocked(MachineView.open).mockRejectedValueOnce(Object.assign(new Error('refused'), { code: 'invalid_arguments' }));
    tap({ orgId: ORG.id, machineId: MACHINE, agentId: 'a1', action: 'open' });
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect(String(vi.mocked(toast.error).mock.calls[0]![0])).toContain('invalid_arguments');
    expect(Push.clearDelivered).not.toHaveBeenCalled();
    tap({ orgId: ORG.id, machineId: MACHINE, agentId: 'a1', action: 'open' });
    await vi.waitFor(() => expect(Push.clearDelivered).toHaveBeenCalledWith({ orgId: ORG.id, machineId: MACHINE, agentId: 'a1' }));
  });

});

// A Meta that passes the schema, with push on: reconcile then asks for the device row.
const PUSH_META = {
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

describe('work for an org that was erased and added again meanwhile', () => {
  /** Starts `onOrgFailure` for the org's current incarnation with its first clean-up write held. */
  async function revokedWithHeldCleanUp() {
    orgStore.set({ loaded: true, orgs: [ORG] });
    settingsStore.set({ ...DEFAULT_SETTINGS, lastMachine: { orgId: ORG.id, machineId: MACHINE, host: 'box.example.com' } });
    const inc = orgIncarnation(ORG.id);
    const real = vi.mocked(SecureStore.set).getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vi.mocked(SecureStore.set).mockImplementationOnce(async (o) => (await gate, real(o)));
    window.location.hash = '#/machines';
    const failing = onOrgFailure(ORG, { kind: 'device_revoked' }, inc).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 0));
    return { failing, release };
  }

  it('an erase waits for a device_revoked clean-up it overlaps; the org added again afterwards stays', async () => {
    const { failing, release } = await revokedWithHeldCleanUp();
    let erased = false;
    const erasing = eraseEverything().then(() => (erased = true));
    await new Promise((r) => setTimeout(r, 10));
    expect(erased).toBe(false);
    release();
    await erasing;
    await failing;
    await addOrg({ id: ORG.id, name: ORG.name, teamDomain: null });
    expect(orgStore.get().orgs.map((o) => o.id)).toEqual([ORG.id]);
    expect(settingsStore.get()).toEqual(DEFAULT_SETTINGS);
    expect(parseRoute(window.location.hash)).toEqual({ name: 'machines' });
  });

  it('a device_revoked clean-up paused while the org is removed and added again elsewhere never removes the new one', async () => {
    const { failing, release } = await revokedWithHeldCleanUp();
    // Another path took the org away and added it again: a new incarnation.
    orgStore.set({ loaded: true, orgs: [] });
    expect(orgIncarnation(ORG.id)).toBeUndefined();
    orgStore.set({ loaded: true, orgs: [ORG] });
    release();
    await failing;
    expect(orgStore.get().orgs.map((o) => o.id)).toEqual([ORG.id]);
    expect(parseRoute(window.location.hash)).toEqual({ name: 'machines' });
  });

  it('a push answer of revoked for the old incarnation is dropped: the new org stays and nothing is shown', async () => {
    orgStore.set({ loaded: true, orgs: [ORG] });
    let installed!: (v: { installId: string }) => void;
    vi.mocked(Session.installId).mockImplementationOnce(() => new Promise((r) => (installed = r)));
    vi.mocked(Session.meta).mockResolvedValue(PUSH_META);
    vi.mocked(Session.request).mockResolvedValue({ kind: 'device_revoked' });
    const reconciling = reconcilePush(ORG);
    await new Promise((r) => setTimeout(r, 0));
    await eraseEverything();
    await addOrg({ id: ORG.id, name: ORG.name, teamDomain: null });
    vi.mocked(Session.signOut).mockClear();
    installed({ installId: 'test-install' });
    await reconciling;
    expect(orgStore.get().orgs.map((o) => o.id)).toEqual([ORG.id]);
    expect(pushStore.get()[ORG.id]).toBeUndefined();
    expect(toast.warning).not.toHaveBeenCalled();
    expect(Session.signOut).not.toHaveBeenCalled();
  });

  it('the same answer for the current incarnation still removes it and its native push keys', async () => {
    orgStore.set({ loaded: true, orgs: [ORG] });
    vi.mocked(Session.meta).mockResolvedValue(PUSH_META);
    vi.mocked(Session.request).mockResolvedValue({ kind: 'device_revoked' });
    vi.mocked(Push.forgetOrg).mockClear();
    await reconcilePush(ORG);
    expect(Push.forgetOrg).toHaveBeenCalledWith({ orgId: ORG.id });
    expect(orgStore.get().orgs).toEqual([]);
    expect(toast.warning).toHaveBeenCalled();
  });

  const replacement = { kind: 'row' as const, state: { kind: 'active' as const }, device: device() };

  it('a revoked device list answered after an erase and re-add deletes none of the new org\'s native push keys', async () => {
    orgStore.set({ loaded: true, orgs: [ORG] });
    vi.mocked(Session.meta).mockResolvedValue(PUSH_META);
    let answer!: (v: { kind: 'device_revoked' }) => void;
    vi.mocked(Session.request).mockImplementationOnce(() => new Promise((r) => (answer = r)));
    const reconciling = reconcilePush(ORG);
    await vi.waitFor(() => expect(Session.request).toHaveBeenCalled());
    await eraseEverything();
    await addOrg({ id: ORG.id, name: ORG.name, teamDomain: null });
    pushStore.set({ [ORG.id]: replacement });
    vi.mocked(Push.forgetOrg).mockClear();
    answer({ kind: 'device_revoked' });
    await reconciling;
    expect(Push.forgetOrg).not.toHaveBeenCalled();
    expect(pushStore.get()[ORG.id]).toEqual(replacement);
    expect(orgStore.get().orgs.map((o) => o.id)).toEqual([ORG.id]);
  });

  it('a sign-out whose unregister waits while the org is replaced touches nothing of the new one', async () => {
    orgStore.set({ loaded: true, orgs: [ORG] });
    let answer!: (v: ApiResult) => void;
    vi.mocked(Session.request).mockImplementationOnce(() => new Promise((r) => (answer = r)));
    const signingOut = signOutOrg(ORG.id);
    await vi.waitFor(() => expect(Session.request).toHaveBeenCalled());
    orgStore.set({ loaded: true, orgs: [] });
    expect(orgIncarnation(ORG.id)).toBeUndefined();
    orgStore.set({ loaded: true, orgs: [ORG] });
    pushStore.set({ [ORG.id]: replacement });
    vi.mocked(Push.forgetOrg).mockClear();
    vi.mocked(Session.signOut).mockClear();
    answer({ kind: 'ok', status: 200, body: { items: [device()], next_cursor: null } });
    await signingOut;
    expect(Push.forgetOrg).not.toHaveBeenCalled();
    expect(Session.signOut).not.toHaveBeenCalled();
    expect(pushStore.get()[ORG.id]).toEqual(replacement);
    expect(orgStore.get().orgs.map((o) => o.id)).toEqual([ORG.id]);
  });

  describe('no install id or device key is minted for an org that went away while push work waited', () => {
    const dropOrg = async (how: 'erase' | 'sign out') => {
      if (how === 'erase') await eraseEverything();
      else await signOutOrg(ORG.id);
    };

    it.each(['erase', 'sign out'] as const)('Turn off with its metadata request held across %s', async (how) => {
      orgStore.set({ loaded: true, orgs: [ORG] });
      let answer!: (v: typeof PUSH_META) => void;
      vi.mocked(Session.meta).mockImplementationOnce(() => new Promise((r) => (answer = r)));
      const turningOff = turnOffPush(ORG);
      await vi.waitFor(() => expect(Session.meta).toHaveBeenCalled());
      await dropOrg(how);
      vi.mocked(Session.installId).mockClear();
      answer(PUSH_META);
      await turningOff;
      expect(Session.installId).not.toHaveBeenCalled();
      expect(Session.deviceKey).not.toHaveBeenCalled();
    });

    it.each(['erase', 'sign out'] as const)('Turn on with its permission prompt answered after %s', async (how) => {
      orgStore.set({ loaded: true, orgs: [ORG] });
      let answer!: (v: { notifications: 'granted' }) => void;
      vi.mocked(Push.checkPermission).mockImplementationOnce(() => new Promise((r) => (answer = r)) as never);
      const turningOn = pushAction(ORG.id, 'turn_on');
      await vi.waitFor(() => expect(Push.checkPermission).toHaveBeenCalled());
      await dropOrg(how);
      vi.mocked(Session.installId).mockClear();
      answer({ notifications: 'granted' });
      await turningOn;
      expect(Session.installId).not.toHaveBeenCalled();
      expect(Push.registerDevice).not.toHaveBeenCalled();
    });

    it('Turn off whose metadata answers while an erase is still running (the org still listed)', async () => {
      orgStore.set({ loaded: true, orgs: [ORG] });
      let answer!: (v: typeof PUSH_META) => void;
      vi.mocked(Session.meta).mockImplementationOnce(() => new Promise((r) => (answer = r)));
      const turningOff = turnOffPush(ORG);
      await vi.waitFor(() => expect(Session.meta).toHaveBeenCalled());
      let wipe!: () => void;
      vi.mocked(SecureStore.eraseAll).mockImplementationOnce(() => new Promise<void>((r) => (wipe = r)));
      const erasing = eraseEverything();
      await vi.waitFor(() => expect(SecureStore.eraseAll).toHaveBeenCalled());
      expect(orgStore.get().orgs.map((o) => o.id)).toEqual([ORG.id]);
      vi.mocked(Session.installId).mockClear();
      answer(PUSH_META);
      await turningOff;
      expect(Session.installId).not.toHaveBeenCalled();
      wipe();
      await erasing;
    });

    it('current work still asks for the install id and registers', async () => {
      orgStore.set({ loaded: true, orgs: [ORG] });
      vi.mocked(Session.meta).mockResolvedValue(PUSH_META);
      vi.mocked(Session.installId).mockClear();
      await pushAction(ORG.id, 'turn_on');
      expect(Session.installId).toHaveBeenCalledWith({ orgId: ORG.id });
      expect(Push.registerDevice).toHaveBeenCalled();
    });
  });

  describe('a late mute answer never touches the pending patch of the org added again', () => {
    const NEW_PATCH = { mute_all: false, muted_until: null };
    /** Holds the mute PATCH; resolves with `answer` once the org was erased and added again. */
    async function lateMute(answer: ApiResult) {
      orgStore.set({ loaded: true, orgs: [ORG] });
      pushStore.set({ [ORG.id]: { kind: 'row', state: { kind: 'active' }, device: device() } });
      vi.mocked(Session.meta).mockResolvedValue(PUSH_META);
      let reply!: (v: ApiResult) => void;
      vi.mocked(Session.request).mockImplementationOnce(() => new Promise((r) => (reply = r)));
      const muting = mutePushOrg(ORG.id, 'forever');
      await vi.waitFor(() => expect(Session.request).toHaveBeenCalled());
      await eraseEverything();
      await addOrg({ id: ORG.id, name: ORG.name, teamDomain: null });
      vi.mocked(Push.forgetOrg).mockClear();
      // The new org's own offline patch, saved before the old answer lands.
      vi.mocked(Session.request).mockResolvedValueOnce({ kind: 'offline' });
      const { muteSync } = await import('./pushDeps.ts');
      await muteSync.apply(scopedPushDeps(() => true), ORG.id, device(), NEW_PATCH);
      expect(muteSync.hasPending(ORG.id)).toBe(true);
      reply(answer);
      await muting;
      return muteSync;
    }

    it.each([
      ['offline', { kind: 'offline' } as ApiResult],
      ['success', { kind: 'ok', status: 200, body: device({ mute_all: true }) } as ApiResult],
      ['revoked', { kind: 'device_revoked' } as ApiResult],
    ])('answered %s: the replacement patch stays exactly as the new org saved it', async (_, answer) => {
      const sync = await lateMute(answer);
      expect(sync.hasPending(ORG.id)).toBe(true);
      // What the next reconcile would send for the new org is its own patch, never mute_all: true.
      vi.mocked(Session.request).mockClear();
      vi.mocked(Session.request).mockResolvedValueOnce({ kind: 'ok', status: 200, body: device() });
      await sync.flush(scopedPushDeps(() => true), ORG.id, device());
      expect(vi.mocked(Session.request).mock.calls.at(-1)![0].body).toEqual(NEW_PATCH);
      expect(Push.forgetOrg).not.toHaveBeenCalled();
      sync.forget();
    });

    it('the current answer still records an offline patch', async () => {
      orgStore.set({ loaded: true, orgs: [ORG] });
      pushStore.set({ [ORG.id]: { kind: 'row', state: { kind: 'active' }, device: device() } });
      vi.mocked(Session.meta).mockResolvedValue(PUSH_META);
      // Offline throughout: the reconcile after the mute retries the patch and keeps it.
      vi.mocked(Session.request).mockResolvedValue({ kind: 'offline' });
      const { muteSync } = await import('./pushDeps.ts');
      await mutePushOrg(ORG.id, 'forever');
      expect(muteSync.hasPending(ORG.id)).toBe(true);
      muteSync.forget();
    });
  });
});
