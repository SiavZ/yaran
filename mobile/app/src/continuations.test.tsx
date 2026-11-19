/**
 * What happens after a share or a link has started, through the real App (round 18): a live share
 * event's routing yields to a move, link or choice made while its status pull is out; a Send or
 * Discard whose reply returns after a newer share arrived keeps the newer share and the chooser;
 * and a link whose lock read an unlock overtook is read again and opens, never stranded.
 *
 * <module-headers:begin>
 * Uses:
 * src/continuations.test.tsx
 * ├── @yaran/protocol:src/index.ts
 * ├── @yaran/push:src/index.ts
 * ├── @yaran/secure-store:src/index.ts
 * ├── src/App.tsx
 * ├── src/lib/buildInfo.ts
 * ├── src/lib/machinesStore.ts
 * ├── src/lib/native/machineView.ts
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
import { resetBuildInfoForTests } from './lib/buildInfo.ts';
import { machinesStore, resetMachines } from './lib/machinesStore.ts';
import { MachineView, Session, type ApiResult } from './lib/native/machineView.ts';
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




describe('a live share event yields to anything newer than its arrival', () => {
  function heldPull() {
    let answer!: () => void;
    vi.mocked(MachineView.shareStatus).mockImplementationOnce(() => new Promise((r) => (answer = () => r({ kind: 'pending', count: 1, batch: 'share-1' } as never))) as never);
    act(() => listener<unknown>(vi.mocked(MachineView.addListener), 'shareReceived')({ kind: 'files', count: 1, dropped: 0, batch: 'share-1' }));
    return { held: () => answer !== undefined, answer: () => answer() };
  }

  it('Settings tapped while its pull is out: the "pending" answer keeps Settings', async () => {
    await reopenWaiting();
    const pull = heldPull();
    await waitFor(() => expect(pull.held()).toBe(true));
    act(() => navigate({ name: 'settings' }));
    await act(async () => pull.answer());
    releaseA();
    await tick();
    await tick();
    expect(window.location.hash).toBe('#/settings');
    expect(opened()).toEqual([]);
  });

  it('an add-org link while its pull is out: the "pending" answer keeps Confirm', async () => {
    await reopenWaiting();
    const pull = heldPull();
    await waitFor(() => expect(pull.held()).toBe(true));
    act(() => listener<{ url: string }>(vi.mocked(CapApp.addListener), 'appUrlOpen')({ url: 'yaranapp://add-org?u=https%3A%2F%2Fnew.example.com' }));
    await waitFor(() => expect(window.location.hash).toMatch(/confirm/));
    await act(async () => pull.answer());
    await tick();
    expect(window.location.hash).toMatch(/confirm/);
  });

  it('control: undisturbed, the share screen shows', async () => {
    await reopenWaiting();
    const pull = heldPull();
    await waitFor(() => expect(pull.held()).toBe(true));
    await act(async () => pull.answer());
    await waitFor(() => expect(window.location.hash).toBe('#/share'));
  });

  it('torn down while its pull is out: nothing navigates', async () => {
    window.location.hash = '#/machines';
    const { unmount } = renderShell(<App />);
    await waitFor(() => expect((vi.mocked(MachineView.addListener).mock.calls as unknown[][]).some((c) => c[0] === 'shareReceived')).toBe(true));
    await tick();
    const pull = heldPull();
    await waitFor(() => expect(pull.held()).toBe(true));
    unmount();
    await act(async () => pull.answer());
    await tick();
    expect(window.location.hash).toBe('#/machines');
  });
});

describe('a Send or Discard reply that returns after a newer share arrived keeps the newer one', () => {
  async function onShareScreen(command: 'send' | 'discard', hold: boolean) {
    settingsStore.set({ ...DEFAULT_SETTINGS });
    vi.mocked(MachineView.shareStatus).mockResolvedValue({ kind: 'pending', count: 1, batch: 'share-1' });
    window.location.hash = '#/share';
    let complete: () => void = () => undefined;
    if (hold) {
      const reply = new Promise<void>((r) => (complete = r));
      if (command === 'send') vi.mocked(MachineView.open).mockImplementationOnce(() => reply);
      else vi.mocked(MachineView.discardShare).mockImplementationOnce(() => reply);
    }
    renderShell(<App />);
    fireEvent.click(await screen.findByRole('button', { name: command === 'send' ? 'linked in Babbage' : 'Cancel and discard' }));
    return () => complete();
  }

  for (const command of ['send', 'discard'] as const) {
    it(`${command}: the newer share stays pending and the chooser stays`, async () => {
      const complete = await onShareScreen(command, true);
      await waitFor(() => expect(command === 'send' ? MachineView.open : MachineView.discardShare).toHaveBeenCalled());
      vi.mocked(MachineView.shareStatus).mockResolvedValue({ kind: 'pending', count: 2, batch: 'share-2' });
      act(() => listener<unknown>(vi.mocked(MachineView.addListener), 'shareReceived')({ kind: 'files', count: 2, dropped: 0, batch: 'share-2' }));
      await waitFor(() => expect(shareStore.get()).toEqual({ kind: 'pending', count: 2, batch: 'share-2' }));
      await act(async () => complete());
      await tick();
      expect(shareStore.get()).toEqual({ kind: 'pending', count: 2, batch: 'share-2' });
      expect(window.location.hash).toBe('#/share');
    });

    it(`control: an undisturbed ${command} clears the share and leaves the chooser`, async () => {
      await onShareScreen(command, false);
      await waitFor(() => expect(shareStore.get()).toEqual({ kind: 'none' }));
      expect(window.location.hash).toBe('#/machines');
    });
  }
});

describe('a link whose lock read an unlock overtook is read again', () => {
  const LOCKED = { ...UNLOCKED, enabled: true, locked: true };
  async function linkReadHeldWhileLocked() {
    settingsStore.set({ ...DEFAULT_SETTINGS });
    vi.mocked(AppLock.status).mockResolvedValue(LOCKED);
    window.location.hash = '#/machines';
    const shell = renderShell(<App />);
    await screen.findByRole('button', { name: 'Unlock' });
    await waitFor(() => expect((vi.mocked(Push.addListener).mock.calls as unknown[][]).some((c) => c[0] === 'notificationTapped')).toBe(true));
    await tick();
    let oldLock!: () => void;
    vi.mocked(AppLock.status).mockImplementationOnce(() => new Promise((r) => (oldLock = () => r(LOCKED))));
    act(() => listener<{ url: string }>(vi.mocked(CapApp.addListener), 'appUrlOpen')({ url: linkB }));
    await waitFor(() => expect(oldLock).toBeTypeOf('function'));
    return { oldLock: () => oldLock(), unmount: shell.unmount };
  }
  const unlockNow = () => act(() => listener<{ locked: boolean }>(vi.mocked(AppLock.addListener), 'lockStateChanged')({ locked: false }));

  it('the old "locked" answer after Unlock: the link opens once, with no second unlock and no hold', async () => {
    const link = await linkReadHeldWhileLocked();
    vi.mocked(AppLock.status).mockResolvedValue(UNLOCKED);
    unlockNow();
    await act(async () => link.oldLock());
    await waitFor(() => expect(opened()).toEqual([LINKED]));
    await tick();
    expect(opened()).toEqual([LINKED]);
    expect(vi.mocked(toast.info).mock.calls.map((c) => String(c[0]))).not.toContain('Unlock yaran to open that link.');
  });

  it('relocked again before the re-read: the link is held, and opens once at the next unlock', async () => {
    const link = await linkReadHeldWhileLocked();
    unlockNow();
    // Locked again by the time the link reads again.
    vi.mocked(AppLock.status).mockResolvedValue(LOCKED);
    await act(async () => link.oldLock());
    await tick();
    expect(opened()).toEqual([]);
    vi.mocked(AppLock.status).mockResolvedValue(UNLOCKED);
    unlockNow();
    await waitFor(() => expect(opened()).toEqual([LINKED]));
  });

  it('torn down while the read is out: nothing opens after Unlock', async () => {
    const link = await linkReadHeldWhileLocked();
    vi.mocked(AppLock.status).mockResolvedValue(UNLOCKED);
    unlockNow();
    link.unmount();
    await act(async () => link.oldLock());
    await tick();
    expect(opened()).toEqual([]);
  });
});
