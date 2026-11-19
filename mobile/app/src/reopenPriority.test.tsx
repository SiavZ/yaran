/**
 * "Reopen last machine" is the lowest priority at launch, for its whole wait, through the real
 * App: a link, a share or a move the user makes while it waits on the machines list outranks it,
 * and it never opens after them. Left alone, it still opens.
 *
 * <module-headers:begin>
 * Uses:
 * src/reopenPriority.test.tsx
 * ├── @yaran/protocol:src/index.ts
 * ├── @yaran/push:src/index.ts
 * ├── @yaran/secure-store:src/index.ts
 * ├── src/App.tsx
 * ├── src/lib/buildInfo.ts
 * ├── src/lib/directStore.ts
 * ├── src/lib/machinesStore.ts
 * ├── src/lib/native/machineView.ts
 * ├── src/lib/openMachine.ts
 * ├── src/lib/orgStore.ts
 * ├── src/lib/route.ts
 * ├── src/lib/settingsStore.ts
 * ├── src/lib/share.ts
 * └── src/test/render.tsx
 * External: @capacitor/app, @testing-library/react, sonner, vitest
 *
 * Used by: entry point (vitest, via npm test in mobile/app)
 * <module-headers:end>
 */
import { App as CapApp } from '@capacitor/app';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { agentLinkUrl } from '@yaran/protocol';
import { Push } from '@yaran/push';
import { AppLock } from '@yaran/secure-store';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from './App.tsx';
import { addDirect, directStore } from './lib/directStore.ts';
import { resetBuildInfoForTests } from './lib/buildInfo.ts';
import { forgetOrgMachines, machinesStore, resetMachines } from './lib/machinesStore.ts';
import { MachineView, Session, type ApiResult } from './lib/native/machineView.ts';
import { machineChoices } from './lib/openMachine.ts';
import { orgStore } from './lib/orgStore.ts';
import { navigate } from './lib/route.ts';
import { DEFAULT_SETTINGS, settingsStore } from './lib/settingsStore.ts';
import { shareStore } from './lib/share.ts';
import { renderShell } from './test/render.tsx';

vi.mock('@yaran/push', async (orig) => ({
  ...(await orig<typeof import('@yaran/push')>()),
  Push: {
    addListener: vi.fn(async () => ({ remove: async () => {} })),
    drainPendingRegistrations: vi.fn(async () => ({ orgIds: [] })),
    clearDelivered: vi.fn(async () => {}),
    forgetOrg: vi.fn(async () => {}),
    setLocalMutes: vi.fn(async () => {}),
    cacheMachineNames: vi.fn(async () => {}),
  },
}));
vi.mock('sonner', async (orig) => ({
  ...(await orig<typeof import('sonner')>()),
  toast: { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn(), loading: vi.fn() },
}));

const DOMAIN = 'apps.example.org';
const ORG_A = { id: 'https://cp.example.com', name: 'Ada', teamDomain: null, addedAt: 'x' };
const ORG_B = { id: 'https://cp2.example.com', name: 'Babbage', teamDomain: null, addedAt: 'x' };
const LAST = '0b5f9a8e-6d0e-4f43-9a51-1d6f7d9b1c2a';
const LINKED = '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b';
const summary = (id: string, hostname: string) => ({
  id,
  name: hostname.split('.')[0]!,
  hostname,
  url: `https://${hostname}`,
  status: 'online',
  status_checked_at: '2026-11-14T12:00:00Z',
  paired_at: '2026-11-14T12:00:00Z',
});
const LIST_A: ApiResult = { kind: 'ok', status: 200, body: { items: [summary(LAST, 'last.example.com')], next_cursor: null } };
const UNLOCKED = { enabled: false, allowPasscode: false, grace: '1min' as const, locked: false, biometry: 'available' as const };
const linkB = agentLinkUrl(DOMAIN, { target: { kind: 'org', orgUrl: ORG_B.id, machineId: LINKED }, agentId: 'b1' });

const tick = () => act(async () => new Promise((r) => setTimeout(r, 5)));
const opened = () => vi.mocked(MachineView.open).mock.calls.map((c) => (c[0] as { machineId?: string }).machineId);
const listener = <E,>(mock: { mock: { calls: unknown[][] } }, name: string) =>
  (mock.mock.calls as [string, (e: E) => void][]).filter((c) => c[0] === name).at(-1)![1];

/** Org A's list (where the last machine is) answers only when released; org B's is cached. */
let releaseA: () => void;
beforeEach(() => {
  resetBuildInfoForTests();
  resetMachines();
  shareStore.set(null);
  vi.mocked(MachineView.open).mockClear();
  orgStore.set({ loaded: true, orgs: [ORG_A, ORG_B] });
  machinesStore.set({ [ORG_B.id]: { state: 'ready', machines: [summary(LINKED, 'linked.example.com')] as never, fetchedAt: Date.now() } });
  settingsStore.set({ ...DEFAULT_SETTINGS, reopenLastMachine: true, lastMachine: { orgId: ORG_A.id, machineId: LAST, host: 'last.example.com' } });
  vi.mocked(Session.callbackMode).mockResolvedValue({ mode: 'https', domain: DOMAIN });
  vi.mocked(AppLock.status).mockResolvedValue(UNLOCKED);
  vi.mocked(MachineView.shareStatus).mockResolvedValue({ kind: 'none' });
  const heldA = new Promise<ApiResult>((r) => (releaseA = () => r(LIST_A)));
  vi.mocked(Session.request).mockImplementation(async ({ orgId }) => (orgId === ORG_A.id ? heldA : { kind: 'ok', status: 200, body: { items: [summary(LINKED, 'linked.example.com')], next_cursor: null } }));
  for (const t of Object.values(toast)) vi.mocked(t).mockClear();
});

/** Renders the App and waits until the reopen is waiting on org A's list. */
async function reopenWaiting() {
  window.location.hash = '';
  renderShell(<App />);
  await waitFor(() => expect(vi.mocked(Session.request).mock.calls.some((c) => c[0].orgId === ORG_A.id)).toBe(true));
  await tick();
  expect(opened()).toEqual([]);
}

describe('the automatic reopen gives way to anything newer', () => {
  it('control: left alone, it opens the last machine once its list loads', async () => {
    await reopenWaiting();
    releaseA();
    await waitFor(() => expect(opened()).toEqual([LAST]));
  });

  it('an agent link arriving while it waits opens its machine, and the last machine never opens after it', async () => {
    await reopenWaiting();
    act(() => listener<{ url: string }>(vi.mocked(CapApp.addListener), 'appUrlOpen')({ url: linkB }));
    await waitFor(() => expect(opened()).toEqual([LINKED]));
    releaseA();
    await tick();
    await tick();
    expect(opened()).toEqual([LINKED]);
  });

  it('a yaranapp link arriving while it waits keeps its screen, and nothing reopens', async () => {
    await reopenWaiting();
    act(() => listener<{ url: string }>(vi.mocked(CapApp.addListener), 'appUrlOpen')({ url: 'yaranapp://add-org?u=https%3A%2F%2Fcp3.example.com' }));
    await waitFor(() => expect(window.location.hash).toMatch(/confirm/));
    releaseA();
    await tick();
    expect(opened()).toEqual([]);
  });

  it('a share arriving while it waits shows the share screen, and nothing reopens', async () => {
    await reopenWaiting();
    vi.mocked(MachineView.shareStatus).mockResolvedValue({ kind: 'pending', count: 1, batch: 'share-1' } as never);
    act(() => listener<unknown>(vi.mocked(MachineView.addListener), 'shareReceived')({ kind: 'files', count: 1, dropped: 0, batch: 'share-1' }));
    await waitFor(() => expect(window.location.hash).toMatch(/share/));
    releaseA();
    await tick();
    expect(opened()).toEqual([]);
  });

  it('the user moving to Settings while it waits keeps them there, and nothing reopens', async () => {
    await reopenWaiting();
    act(() => navigate({ name: 'settings' }));
    releaseA();
    await tick();
    await tick();
    expect(opened()).toEqual([]);
    expect(window.location.hash).toMatch(/settings/);
  });

  it('the user moving to Settings while the startup share check is still out keeps them there, and nothing reopens', async () => {
    let shareAnswer!: (v: { kind: 'none' }) => void;
    vi.mocked(MachineView.shareStatus).mockImplementationOnce(() => new Promise((r) => (shareAnswer = r)) as never);
    window.location.hash = '';
    renderShell(<App />);
    await waitFor(() => expect(MachineView.shareStatus).toHaveBeenCalled());
    act(() => navigate({ name: 'settings' }));
    shareAnswer({ kind: 'none' });
    releaseA();
    await tick();
    await tick();
    expect(opened()).toEqual([]);
    expect(window.location.hash).toMatch(/settings/);
  });

  it('a machine the user opens while it waits is the only one that opens', async () => {
    await reopenWaiting();
    fireEvent.click(await screen.findByText('linked'));
    await waitFor(() => expect(opened()).toEqual([LINKED]));
    releaseA();
    await tick();
    await tick();
    expect(opened()).toEqual([LINKED]);
  });
});

describe('a file share is newer than the automatic reopen from its arrival', () => {
  it('its status pull held: nothing opens before or after the pull answers, and the share screen shows', async () => {
    await reopenWaiting();
    let releaseShare!: () => void;
    vi.mocked(MachineView.shareStatus).mockImplementationOnce(() => new Promise((r) => (releaseShare = () => r({ kind: 'pending', count: 1, batch: 'share-1' } as never))) as never);
    act(() => listener<unknown>(vi.mocked(MachineView.addListener), 'shareReceived')({ kind: 'files', count: 1, dropped: 0, batch: 'share-1' }));
    await waitFor(() => expect(releaseShare).toBeTypeOf('function'));
    releaseA();
    await tick();
    await tick();
    expect(opened()).toEqual([]);
    releaseShare();
    await waitFor(() => expect(window.location.hash).toMatch(/share/));
    expect(opened()).toEqual([]);
  });

  it('a refused share (no files) is not a share to show: it says why, and the last machine still reopens', async () => {
    await reopenWaiting();
    act(() => listener<unknown>(vi.mocked(MachineView.addListener), 'shareReceived')({ kind: 'refused', reason: 'no_files' }));
    expect(toast.warning).toHaveBeenCalledTimes(1);
    releaseA();
    await waitFor(() => expect(opened()).toEqual([LAST]));
  });
});

describe('a notification Open is a choice the automatic reopen gives way to', () => {
  async function tap(event: object) {
    await waitFor(() => expect((vi.mocked(Push.addListener).mock.calls as unknown[][]).some((c) => c[0] === 'notificationTapped')).toBe(true));
    act(() => listener<unknown>(vi.mocked(Push.addListener), 'notificationTapped')(event));
  }
  const openB = { orgId: ORG_B.id, machineId: LINKED, agentId: 'b1', action: 'open' };

  it("B's list cached: B opens and its alert clears, and releasing A's list opens nothing more", async () => {
    vi.mocked(Push.clearDelivered).mockClear();
    await reopenWaiting();
    await tap(openB);
    await waitFor(() => expect(opened()).toEqual([LINKED]));
    await waitFor(() => expect(Push.clearDelivered).toHaveBeenCalledWith({ orgId: ORG_B.id, machineId: LINKED, agentId: 'b1' }));
    releaseA();
    await tick();
    await tick();
    expect(opened()).toEqual([LINKED]);
  });

  it("B's list cold and held too, A's released first: only B ever opens", async () => {
    await reopenWaiting();
    let releaseB!: () => void;
    const listB = new Promise<ApiResult>((r) => (releaseB = () => r({ kind: 'ok', status: 200, body: { items: [summary(LINKED, 'linked.example.com')], next_cursor: null } })));
    const real = vi.mocked(Session.request).getMockImplementation()!;
    vi.mocked(Session.request).mockImplementation(async (o) => (o.orgId === ORG_B.id ? listB : real(o)));
    act(() => forgetOrgMachines(ORG_B.id));
    await tap(openB);
    releaseA();
    await tick();
    await tick();
    expect(opened()).toEqual([]);
    releaseB();
    await waitFor(() => expect(opened()).toEqual([LINKED]));
  });

  it('a failed notification Open keeps its alert, and is still the choice', async () => {
    vi.mocked(Push.clearDelivered).mockClear();
    vi.mocked(MachineView.open).mockRejectedValueOnce(Object.assign(new Error('no'), { code: 'native_error' }));
    await reopenWaiting();
    await tap(openB);
    await waitFor(() => expect(opened()).toEqual([LINKED]));
    releaseA();
    await tick();
    await tick();
    expect(opened()).toEqual([LINKED]);
    expect(Push.clearDelivered).not.toHaveBeenCalled();
  });

  for (const [name, event] of [
    ['a Mute this machine', { ...openB, action: 'mute_machine' }],
    ['a malformed tap', { orgId: ORG_B.id }],
  ] as const) {
    it(`${name} is not a machine choice: the last machine still reopens`, async () => {
      await reopenWaiting();
      const before = machineChoices();
      await tap(event);
      expect(machineChoices()).toBe(before);
      releaseA();
      await waitFor(() => expect(opened()).toContain(LAST));
      expect(opened()).not.toContain(LINKED);
    });
  }

  it('a tap for an org this phone does not have is not a machine choice (it shows Machines and says why)', async () => {
    await reopenWaiting();
    const before = machineChoices();
    await tap({ ...openB, orgId: 'https://gone.example.com' });
    expect(machineChoices()).toBe(before);
    await waitFor(() => expect(toast.info).toHaveBeenCalled());
    expect(opened()).toEqual([]);
  });
});

describe('a delayed startup share answer never replaces a newer destination', () => {
  function heldStartupShare() {
    let answer!: (v: unknown) => void;
    vi.mocked(MachineView.shareStatus).mockImplementationOnce(() => new Promise((r) => (answer = r)) as never);
    window.location.hash = '';
    renderShell(<App />);
    return { held: () => answer !== undefined, answer: (v: unknown) => answer(v) };
  }

  it('Settings tapped while the startup share check is out: a "pending" answer keeps Settings, and nothing opens', async () => {
    const share = heldStartupShare();
    await waitFor(() => expect(share.held()).toBe(true));
    act(() => navigate({ name: 'settings' }));
    await act(async () => share.answer({ kind: 'pending', count: 1, batch: 'share-1' }));
    releaseA();
    await tick();
    await tick();
    expect(window.location.hash).toBe('#/settings');
    expect(opened()).toEqual([]);
  });

  it('an add-org link arriving while the startup share check is out: a "pending" answer keeps its Confirm screen', async () => {
    const share = heldStartupShare();
    await waitFor(() => expect(share.held()).toBe(true));
    act(() => listener<{ url: string }>(vi.mocked(CapApp.addListener), 'appUrlOpen')({ url: 'yaranapp://add-org?u=https%3A%2F%2Fnew.example.com' }));
    await waitFor(() => expect(window.location.hash).toMatch(/confirm/));
    await act(async () => share.answer({ kind: 'pending', count: 1, batch: 'share-1' }));
    releaseA();
    await tick();
    await tick();
    expect(window.location.hash).toMatch(/confirm/);
    expect(opened()).toEqual([]);
  });

  it('control: with nothing newer, a cold startup share still wins over the reopen', async () => {
    const share = heldStartupShare();
    await waitFor(() => expect(share.held()).toBe(true));
    await act(async () => share.answer({ kind: 'pending', count: 1, batch: 'share-1' }));
    releaseA();
    await waitFor(() => expect(window.location.hash).toBe('#/share'));
    await tick();
    expect(opened()).toEqual([]);
  });

  it('an older startup "none" answering after a newer files event: nothing opens before or after its own pull, and the share shows', async () => {
    const share = heldStartupShare();
    await waitFor(() => expect(share.held()).toBe(true));
    let newer!: () => void;
    vi.mocked(MachineView.shareStatus).mockImplementationOnce(() => new Promise((r) => (newer = () => r({ kind: 'pending', count: 1, batch: 'share-1' } as never))) as never);
    act(() => listener<unknown>(vi.mocked(MachineView.addListener), 'shareReceived')({ kind: 'files', count: 1, dropped: 0, batch: 'share-1' }));
    await waitFor(() => expect(newer).toBeTypeOf('function'));
    await act(async () => share.answer({ kind: 'none' }));
    releaseA();
    await tick();
    await tick();
    expect(opened()).toEqual([]);
    vi.mocked(MachineView.shareStatus).mockResolvedValue({ kind: 'pending', count: 1, batch: 'share-1' } as never);
    await act(async () => newer());
    await waitFor(() => expect(window.location.hash).toBe('#/share'));
    expect(opened()).toEqual([]);
  });
});

describe('Keep and open is a choice at the press', () => {
  const host = 'kept.example.com';
  async function keepPressed(answer: Promise<unknown>) {
    const r = await addDirect({ host, instance: 'old' });
    vi.mocked(Session.routeStatus).mockImplementationOnce(() => answer as never);
    window.location.hash = '#/machines';
    renderShell(<App />);
    await waitFor(() => expect(vi.mocked(Session.request).mock.calls.some((c) => c[0].orgId === ORG_A.id)).toBe(true));
    act(() => listener<unknown>(vi.mocked(MachineView.addListener), 'closed')({ reason: 'error', code: 'instance_changed', host, requestedHost: host }));
    fireEvent.click(await screen.findByRole('button', { name: 'Keep and open' }));
    await waitFor(() => expect(Session.routeStatus).toHaveBeenCalled());
    releaseA();
    await tick();
    await tick();
    expect(opened()).toEqual([]);
    return r.id;
  }
  const directOpens = () => vi.mocked(MachineView.open).mock.calls.filter((c) => (c[0] as { kind?: string }).kind === 'direct');

  it('the probe held while the last machine list loads: the last machine never opens, and Keep opens the kept one', async () => {
    let answer!: () => void;
    const id = await keepPressed(new Promise((r) => (answer = () => r({ kind: 'yaran', instance: 'new', passwordSet: false, requiredHere: false, signedIn: false, transportEncrypted: true }))));
    await act(async () => answer());
    await waitFor(() => expect(directOpens()).toHaveLength(1));
    expect(opened()).not.toContain(LAST);
    expect(directStore.get().machines.find((m) => m.id === id)?.instance).toBe('new');
    directStore.set({ loaded: true, machines: [] });
  });

  it('the probe failing: still no reopen, nothing opens, and the record keeps its identity', async () => {
    let answer!: () => void;
    const id = await keepPressed(new Promise((r) => (answer = () => r({ kind: 'offline' }))));
    await act(async () => answer());
    await tick();
    expect(vi.mocked(MachineView.open)).not.toHaveBeenCalled();
    expect(directStore.get().machines.find((m) => m.id === id)?.instance).toBe('old');
    directStore.set({ loaded: true, machines: [] });
  });
});
