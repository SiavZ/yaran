/**
 * Launch ordering through the real App: a launch link (agent, add-org, add-machine) claims the
 * launch before "Reopen last machine" may run, however slowly the launch URL, the build facts,
 * the lock state and the machines list answer; nothing opens after unmount; a waiting share
 * still wins over reopening; a locked launch link opens exactly once after unlock; and later
 * links and later launches are not suppressed.
 *
 * <module-headers:begin>
 * Uses:
 * src/launch.test.tsx
 * ├── @yaran/protocol:src/index.ts
 * ├── @yaran/secure-store:src/index.ts
 * ├── src/App.tsx
 * ├── src/lib/buildInfo.ts
 * ├── src/lib/machinesStore.ts
 * ├── src/lib/native/machineView.ts
 * ├── src/lib/orgStore.ts
 * ├── src/lib/route.ts
 * ├── src/lib/settingsStore.ts
 * └── src/test/render.tsx
 * External: @capacitor/app, @testing-library/react, react, sonner, vitest
 *
 * Used by: entry point (vitest, via npm test in mobile/app)
 * <module-headers:end>
 */
import { App as CapApp } from '@capacitor/app';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { agentLinkUrl, type MachineSummary } from '@yaran/protocol';
import { AppLock } from '@yaran/secure-store';
import { StrictMode } from 'react';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from './App.tsx';
import { resetBuildInfoForTests } from './lib/buildInfo.ts';
import { machinesStore, resetMachines } from './lib/machinesStore.ts';
import { MachineView, Session, type ApiResult, type CallbackMode } from './lib/native/machineView.ts';
import { orgStore } from './lib/orgStore.ts';
import { parseRoute } from './lib/route.ts';
import { DEFAULT_SETTINGS, settingsStore } from './lib/settingsStore.ts';
import { renderShell } from './test/render.tsx';

vi.mock('sonner', async (orig) => ({
  ...(await orig<typeof import('sonner')>()),
  toast: { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn(), loading: vi.fn() },
}));

const DOMAIN = 'apps.example.org';
const ORG = { id: 'https://cp.example.com', name: 'Ada', teamDomain: null, addedAt: 'x' };
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
const LIST: ApiResult = { kind: 'ok', status: 200, body: { items: [summary(LAST, 'last.example.com'), summary(LINKED, 'linked.example.com')], next_cursor: null } };
const UNLOCKED = { enabled: false, allowPasscode: false, grace: '1min' as const, locked: false, biometry: 'available' as const };
const LOCKED = { ...UNLOCKED, enabled: true, locked: true };
const link = agentLinkUrl(DOMAIN, { target: { kind: 'org', orgUrl: ORG.id, machineId: LINKED }, agentId: 'a1' });

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
const tick = () => act(async () => new Promise((r) => setTimeout(r, 5)));
const opened = () => vi.mocked(MachineView.open).mock.calls.map((c) => c[0]);
const listener = <E,>(mock: { mock: { calls: unknown[][] } }, name: string) =>
  (mock.mock.calls as [string, (e: E) => void][]).filter((c) => c[0] === name).at(-1)![1];

beforeEach(() => {
  resetBuildInfoForTests();
  resetMachines();
  orgStore.set({ loaded: true, orgs: [ORG] });
  settingsStore.set({ ...DEFAULT_SETTINGS, reopenLastMachine: true, lastMachine: { orgId: ORG.id, machineId: LAST, host: 'last.example.com' } });
  vi.mocked(Session.callbackMode).mockResolvedValue({ mode: 'https', domain: DOMAIN });
  vi.mocked(Session.request).mockResolvedValue(LIST);
  vi.mocked(AppLock.status).mockResolvedValue(UNLOCKED);
  vi.mocked(MachineView.shareStatus).mockResolvedValue({ kind: 'none' });
});

describe('launch ordering', () => {
  it('a delayed launch URL gives way to a newer received agent link', async () => {
    const launch = deferred<{ url: string } | undefined>();
    vi.mocked(CapApp.getLaunchUrl).mockReturnValueOnce(launch.promise);
    renderShell(<App />);
    await waitFor(() => expect(CapApp.getLaunchUrl).toHaveBeenCalled());
    const newer = agentLinkUrl(DOMAIN, { target: { kind: 'org', orgUrl: ORG.id, machineId: LINKED }, agentId: 'newer' });
    act(() => listener<{ url: string }>(vi.mocked(CapApp.addListener), 'appUrlOpen')({ url: newer }));
    await waitFor(() => expect(opened()).toHaveLength(1));
    await act(async () => { launch.resolve({ url: link }); });
    await tick();
    expect(opened().map((o) => o.route)).toEqual(['#/agent/newer']);
  });

  it('a delayed launch URL gives way to a newer Settings move', async () => {
    const launch = deferred<{ url: string } | undefined>();
    vi.mocked(CapApp.getLaunchUrl).mockReturnValueOnce(launch.promise);
    renderShell(<App />);
    await waitFor(() => expect(CapApp.getLaunchUrl).toHaveBeenCalled());
    act(() => { window.location.hash = '#/settings'; });
    await act(async () => { launch.resolve({ url: link }); });
    await tick();
    expect(opened()).toEqual([]);
    expect(window.location.hash).toBe('#/settings');
  });

  it('a slow launch agent link opens its machine, and the last machine never opens ahead of it', async () => {
    const launch = deferred<{ url: string } | undefined>();
    const build = deferred<CallbackMode>();
    const status = deferred<typeof UNLOCKED>();
    const list = deferred<ApiResult>();
    vi.mocked(CapApp.getLaunchUrl).mockReturnValueOnce(launch.promise);
    vi.mocked(Session.callbackMode).mockReturnValueOnce(build.promise);
    vi.mocked(AppLock.status).mockReturnValueOnce(status.promise);
    vi.mocked(Session.request).mockReturnValueOnce(list.promise);
    renderShell(<App />);
    status.resolve(UNLOCKED);
    await tick();
    expect(opened()).toEqual([]);
    launch.resolve({ url: link });
    await tick();
    build.resolve({ mode: 'https', domain: DOMAIN });
    await tick();
    expect(opened()).toEqual([]);
    list.resolve(LIST);
    await waitFor(() => expect(opened()).toHaveLength(1));
    await tick();
    expect(opened()).toEqual([{ orgId: ORG.id, machineId: LINKED, host: 'linked.example.com', route: '#/agent/a1' }]);
  });

  it.each([
    ['add-org', 'yaranapp://add-org?u=https%3A%2F%2Fcp2.example.com', { name: 'confirm', url: 'https://cp2.example.com' }],
    ['add-machine', 'yaranapp://add-machine?u=https%3A%2F%2Fbox.tail1.ts.net', { name: 'confirm-machine', host: 'box.tail1.ts.net' }],
  ])('a launch %s link keeps its Confirm screen instead of reopening', async (_, url, route) => {
    const launch = deferred<{ url: string } | undefined>();
    vi.mocked(CapApp.getLaunchUrl).mockReturnValueOnce(launch.promise);
    renderShell(<App />);
    await tick();
    launch.resolve({ url });
    await waitFor(() => expect(parseRoute(window.location.hash)).toEqual(route));
    await tick();
    expect(opened()).toEqual([]);
  });

  it('nothing opens by itself after unmount, at any stage of the launch', async () => {
    const launch = deferred<{ url: string } | undefined>();
    vi.mocked(CapApp.getLaunchUrl).mockReturnValueOnce(launch.promise);
    const first = renderShell(<App />);
    await tick();
    first.unmount();
    launch.resolve(undefined);
    await tick();
    expect(opened()).toEqual([]);

    // Unmounted while reopening waits on the last machine's list.
    resetMachines();
    const list = deferred<ApiResult>();
    vi.mocked(Session.request).mockReturnValueOnce(list.promise);
    const second = renderShell(<App />);
    await waitFor(() => expect(MachineView.shareStatus).toHaveBeenCalled());
    await tick();
    second.unmount();
    list.resolve(LIST);
    await tick();
    expect(opened()).toEqual([]);
  });

  it('with no launch link the last machine reopens, and a later link still opens', async () => {
    renderShell(<App />);
    await waitFor(() => expect(opened()).toEqual([{ orgId: ORG.id, machineId: LAST, host: 'last.example.com' }]));
    listener<{ url: string }>(vi.mocked(CapApp.addListener), 'appUrlOpen')({ url: link });
    await waitFor(() => expect(opened()).toHaveLength(2));
    expect(opened()[1]).toMatchObject({ machineId: LINKED, route: '#/agent/a1' });
  });

  it('a link in one launch does not stop the next launch from reopening', async () => {
    vi.mocked(CapApp.getLaunchUrl).mockResolvedValueOnce({ url: 'yaranapp://settings' });
    const first = renderShell(<App />);
    await waitFor(() => expect(parseRoute(window.location.hash)).toEqual({ name: 'settings' }));
    await tick();
    expect(opened()).toEqual([]);
    first.unmount();
    window.location.hash = '';
    renderShell(<App />);
    await waitFor(() => expect(opened()).toHaveLength(1));
  });

  it('a waiting share wins over reopening, and a later share still shows', async () => {
    vi.mocked(MachineView.shareStatus).mockResolvedValueOnce({ kind: 'pending', count: 1, batch: 'share-1' });
    renderShell(<App />);
    await waitFor(() => expect(parseRoute(window.location.hash)).toEqual({ name: 'share' }));
    await tick();
    expect(opened()).toEqual([]);
    window.location.hash = '#/machines';
    vi.mocked(MachineView.shareStatus).mockResolvedValue({ kind: 'pending', count: 2, batch: 'share-2' });
    act(() => listener<unknown>(vi.mocked(MachineView.addListener), 'shareReceived')({ kind: 'files', count: 2, dropped: 0, batch: 'share-2' }));
    await waitFor(() => expect(parseRoute(window.location.hash)).toEqual({ name: 'share' }));
  });

  it('a locked launch link opens nothing, then opens exactly once after unlock', async () => {
    vi.mocked(AppLock.status).mockResolvedValue(LOCKED);
    vi.mocked(CapApp.getLaunchUrl).mockResolvedValueOnce({ url: link });
    machinesStore.set({ [ORG.id]: { state: 'ready', machines: [summary(LINKED, 'linked.example.com') as MachineSummary], fetchedAt: 0 } });
    renderShell(<App />);
    const unlock = await screen.findByRole('button', { name: 'Unlock' });
    await tick();
    expect(opened()).toEqual([]);
    vi.mocked(AppLock.status).mockResolvedValue(UNLOCKED);
    fireEvent.click(unlock);
    // Native also announces the unlock; the held link must not open twice.
    act(() => listener<{ locked: boolean }>(vi.mocked(AppLock.addListener), 'lockStateChanged')({ locked: false }));
    await waitFor(() => expect(opened()).toHaveLength(1));
    await tick();
    expect(opened()).toEqual([{ orgId: ORG.id, machineId: LINKED, host: 'linked.example.com', route: '#/agent/a1' }]);
  });

  it('an unreadable lock state at launch reopens nothing', async () => {
    vi.mocked(AppLock.status).mockRejectedValue(new Error('unavailable'));
    renderShell(<App />);
    await tick();
    await tick();
    expect(opened()).toEqual([]);
  });

  it('a valid launch link that resolves after unmount opens nothing', async () => {
    const launch = deferred<{ url: string } | undefined>();
    vi.mocked(CapApp.getLaunchUrl).mockReturnValueOnce(launch.promise);
    machinesStore.set({ [ORG.id]: { state: 'ready', machines: [summary(LINKED, 'linked.example.com') as MachineSummary], fetchedAt: 0 } });
    const view = renderShell(<App />);
    await tick();
    view.unmount();
    launch.resolve({ url: link });
    await tick();
    await tick();
    expect(opened()).toEqual([]);
  });

  it('under StrictMode a launch link opens once', async () => {
    vi.mocked(CapApp.getLaunchUrl).mockResolvedValue({ url: link });
    machinesStore.set({ [ORG.id]: { state: 'ready', machines: [summary(LINKED, 'linked.example.com') as MachineSummary], fetchedAt: 0 } });
    renderShell(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    await waitFor(() => expect(opened()).toHaveLength(1));
    await tick();
    await tick();
    expect(opened()).toHaveLength(1);
    vi.mocked(CapApp.getLaunchUrl).mockResolvedValue(undefined);
  });

  it('a pending-share pull that answers after unmount does not navigate', async () => {
    const share = deferred<{ kind: 'pending'; count: number; batch: string }>();
    vi.mocked(MachineView.shareStatus).mockReturnValueOnce(share.promise);
    window.location.hash = '#/settings';
    const view = renderShell(<App />);
    await waitFor(() => expect(MachineView.shareStatus).toHaveBeenCalled());
    view.unmount();
    share.resolve({ kind: 'pending', count: 1, batch: 'share-1' });
    await tick();
    expect(parseRoute(window.location.hash)).toEqual({ name: 'settings' });
    expect(opened()).toEqual([]);
  });

  it.each(['content://media/external/images/1', 'file:///storage/emulated/0/a.png'])(
    'a %s launch URL is not a link: no warning, and the waiting share still shows',
    async (url) => {
      vi.mocked(CapApp.getLaunchUrl).mockResolvedValueOnce({ url });
      vi.mocked(MachineView.shareStatus).mockResolvedValueOnce({ kind: 'pending', count: 1, batch: 'share-1' });
      renderShell(<App />);
      await waitFor(() => expect(parseRoute(window.location.hash)).toEqual({ name: 'share' }));
      await tick();
      expect(toast.warning).not.toHaveBeenCalled();
      expect(opened()).toEqual([]);
    },
  );

  it.each([
    ['launch URL first', true],
    ['appUrlOpen first', false],
  ])('the same launch link from both deliveries opens once (%s), and a later tap opens again', async (_, launchFirst) => {
    machinesStore.set({ [ORG.id]: { state: 'ready', machines: [summary(LINKED, 'linked.example.com') as MachineSummary], fetchedAt: 0 } });
    const launch = deferred<{ url: string } | undefined>();
    vi.mocked(CapApp.getLaunchUrl).mockReturnValueOnce(launch.promise);
    renderShell(<App />);
    // appUrlOpen is wired before the slow launch URL answers, so nothing is missed.
    await waitFor(() => expect((vi.mocked(CapApp.addListener).mock.calls as unknown[][]).some((c) => c[0] === 'appUrlOpen')).toBe(true));
    const tap = listener<{ url: string }>(vi.mocked(CapApp.addListener), 'appUrlOpen');
    if (launchFirst) {
      launch.resolve({ url: link });
      await tick();
      tap({ url: link });
    } else {
      tap({ url: link });
      await tick();
      launch.resolve({ url: link });
    }
    await waitFor(() => expect(opened()).toHaveLength(1));
    await tick();
    await tick();
    expect(opened()).toHaveLength(1);
    tap({ url: link });
    await waitFor(() => expect(opened()).toHaveLength(2));
  });

  describe('unlocking on the lock screen while the listeners are still going in', () => {
    async function heldWhileInstalling() {
      machinesStore.set({ [ORG.id]: { state: 'ready', machines: [summary(LINKED, 'linked.example.com') as MachineSummary], fetchedAt: 0 } });
      vi.mocked(AppLock.status).mockResolvedValue(LOCKED);
      const launch = deferred<{ url: string } | undefined>();
      vi.mocked(CapApp.getLaunchUrl).mockReturnValueOnce(launch.promise);
      const view = renderShell(<App />);
      const unlock = await screen.findByRole('button', { name: 'Unlock' });
      await waitFor(() => expect((vi.mocked(CapApp.addListener).mock.calls as unknown[][]).some((c) => c[0] === 'appUrlOpen')).toBe(true));
      listener<{ url: string }>(vi.mocked(CapApp.addListener), 'appUrlOpen')({ url: link });
      await tick();
      expect(opened()).toEqual([]);
      return { view, unlock, launch };
    }

    it('the held link opens exactly once after the install finishes', async () => {
      const { unlock, launch } = await heldWhileInstalling();
      vi.mocked(AppLock.status).mockResolvedValue(UNLOCKED);
      fireEvent.click(unlock);
      await tick();
      expect(opened()).toEqual([]);
      launch.resolve(undefined);
      await waitFor(() => expect(opened()).toHaveLength(1));
      act(() => listener<{ locked: boolean }>(vi.mocked(AppLock.addListener), 'lockStateChanged')({ locked: false }));
      await tick();
      await tick();
      expect(opened()).toEqual([{ orgId: ORG.id, machineId: LINKED, host: 'linked.example.com', route: '#/agent/a1' }]);
    });

    it('a lock state that cannot be read once the install finishes opens nothing', async () => {
      const { unlock, launch } = await heldWhileInstalling();
      vi.mocked(AppLock.unlock).mockResolvedValueOnce({ outcome: 'unlocked' });
      fireEvent.click(unlock);
      vi.mocked(AppLock.status).mockRejectedValue(new Error('unavailable'));
      launch.resolve(undefined);
      await tick();
      await tick();
      expect(opened()).toEqual([]);
    });

    it('leaving before the install finishes opens nothing and leaves no listener behind', async () => {
      const remove = vi.fn(async () => {});
      vi.mocked(AppLock.addListener).mockResolvedValueOnce({ remove });
      const { view, unlock, launch } = await heldWhileInstalling();
      vi.mocked(AppLock.status).mockResolvedValue(UNLOCKED);
      fireEvent.click(unlock);
      view.unmount();
      launch.resolve(undefined);
      await tick();
      await tick();
      expect(opened()).toEqual([]);
      expect(remove).toHaveBeenCalledTimes(1);
    });
  });

  describe('the lock screen follows the newest lock state', () => {
    const lockedShown = () => screen.queryByRole('button', { name: 'Unlock' }) !== null;

    it('a first read that answers unlocked after a newer lock event never shows the shell', async () => {
      const first = deferred<typeof UNLOCKED>();
      // The second (final) read stays out too, so only the late first read could unlock the shell.
      vi.mocked(AppLock.status).mockReturnValueOnce(first.promise).mockReturnValueOnce(new Promise(() => {}));
      renderShell(<App />);
      await waitFor(() => expect((vi.mocked(AppLock.addListener).mock.calls as unknown[][]).some((c) => c[0] === 'lockStateChanged')).toBe(true));
      act(() => listener<{ locked: boolean }>(vi.mocked(AppLock.addListener), 'lockStateChanged')({ locked: true }));
      expect(lockedShown()).toBe(true);
      await act(async () => first.resolve(UNLOCKED));
      await tick();
      expect(lockedShown()).toBe(true);
      expect(opened()).toEqual([]);
    });

    it.each([
      ['plain', false],
      ['StrictMode', true],
    ])('a final read of locked after an unlocked start shows the lock screen and opens nothing (%s)', async (_, strict) => {
      vi.mocked(AppLock.status).mockResolvedValueOnce(UNLOCKED).mockResolvedValue(LOCKED);
      if (strict) {
        renderShell(
          <StrictMode>
            <App />
          </StrictMode>,
        );
      } else {
        renderShell(<App />);
      }
      await waitFor(() => expect(lockedShown()).toBe(true));
      await tick();
      await tick();
      expect(lockedShown()).toBe(true);
      expect(opened()).toEqual([]);
    });

    it('an unreadable final read opens nothing', async () => {
      vi.mocked(AppLock.status).mockResolvedValueOnce(UNLOCKED).mockRejectedValue(new Error('unavailable'));
      renderShell(<App />);
      await tick();
      await tick();
      expect(opened()).toEqual([]);
    });
  });
});
