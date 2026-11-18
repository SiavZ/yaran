/**
 * Explicit opens act at the press and never late (round 24), through the real App: a manual
 * Open no longer waits on its convenience "remember" write, so a newer link, Settings or a
 * teardown while that write is out can never be followed by a stale open; and Keep and open
 * carries its own claim (the App up, the address, no newer machine chosen) to the native open,
 * so a newer choice made while its check is out wins.
 *
 * <module-headers:begin>
 * Uses:
 * src/explicitOpen.test.tsx
 * ├── @yaran/protocol:src/index.ts
 * ├── @yaran/push:src/index.ts
 * ├── @yaran/secure-store:src/index.ts
 * ├── src/App.tsx
 * ├── src/lib/buildInfo.ts
 * ├── src/lib/directStore.ts
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
import { AppLock, SecureStore } from '@yaran/secure-store';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from './App.tsx';
import { resetBuildInfoForTests } from './lib/buildInfo.ts';
import { directStore } from './lib/directStore.ts';
import { machinesStore, resetMachines } from './lib/machinesStore.ts';
import { MachineView, Session } from './lib/native/machineView.ts';
import { orgStore } from './lib/orgStore.ts';
import { navigate } from './lib/route.ts';
import { DEFAULT_SETTINGS, settingsStore } from './lib/settingsStore.ts';
import { setShare } from './lib/share.ts';
import { renderShell } from './test/render.tsx';

vi.mock('@yaran/push', async (orig) => ({
  ...(await orig<typeof import('@yaran/push')>()),
  Push: { addListener: vi.fn(async () => ({ remove: async () => {} })), drainPendingRegistrations: vi.fn(async () => ({ orgIds: [] })), forgetOrg: vi.fn(async () => {}), cacheMachineNames: vi.fn(async () => {}), clearDelivered: vi.fn(async () => {}) },
}));
vi.mock('sonner', async (orig) => ({
  ...(await orig<typeof import('sonner')>()),
  toast: { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn(), loading: vi.fn() },
}));

const ORG = 'https://cp.example.com';
const M = '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b';
const B = '0b5f9a8e-6d0e-4f43-9a51-1d6f7d9b1c2a';
const tick = () => act(async () => new Promise((r) => setTimeout(r, 20)));
const listener = <E,>(mock: { mock: { calls: unknown[][] } }, name: string) => (mock.mock.calls as [string, (e: E) => void][]).filter((c) => c[0] === name).at(-1)![1];
const opens = () => vi.mocked(MachineView.open).mock.calls.map((c) => c[0] as { machineId?: string; host?: string; route?: string });
const linkB = agentLinkUrl('apps.example.org', { target: { kind: 'org', orgUrl: ORG, machineId: B }, agentId: 'newer' });
const DIRECT = { id: 'direct', label: 'direct-box', host: 'direct.example.com', instance: 'inst', addedAt: 'x', routes: [{ kind: 'direct' as const, host: 'direct.example.com' }] };
const writeStore = vi.mocked(SecureStore.set).getMockImplementation()!;

beforeEach(() => {
  vi.mocked(SecureStore.set).mockReset().mockImplementation(writeStore);
  resetBuildInfoForTests();
  resetMachines();
  setShare({ kind: 'none' });
  settingsStore.set({ ...DEFAULT_SETTINGS });
  directStore.set({ loaded: true, machines: [] });
  orgStore.set({ loaded: true, orgs: [{ id: ORG, name: 'Ada', teamDomain: null, addedAt: 'x' }] });
  const m = { id: M, name: 'box', hostname: 'box.example.com', url: 'https://box.example.com', status: 'online', status_checked_at: '2026-11-14T12:00:00Z', paired_at: '2026-11-14T12:00:00Z' };
  const b = { ...m, id: B, name: 'newer-box', hostname: 'newer.example.com', url: 'https://newer.example.com' };
  machinesStore.set({ [ORG]: { state: 'ready', machines: [m, b] as never, fetchedAt: 0 } });
  vi.mocked(Session.request).mockResolvedValue({ kind: 'ok', status: 200, body: { items: [m, b], next_cursor: null } });
  vi.mocked(Session.callbackMode).mockResolvedValue({ mode: 'https', domain: 'apps.example.org' });
  vi.mocked(MachineView.open).mockClear();
});

async function onMachines() {
  window.location.hash = '#/machines';
  const shell = renderShell(<App />);
  await waitFor(() => expect((vi.mocked(CapApp.addListener).mock.calls as unknown[][]).some((c) => c[0] === 'appUrlOpen')).toBe(true));
  await tick();
  return shell;
}

describe('a manual Open does not wait on remembering it', () => {
  for (const kind of ['org', 'direct'] as const) {
    for (const newer of ['an agent link', 'Settings', 'teardown'] as const) {
      it(`${kind}: opens at the tap while the remember write is out; ${newer} afterwards brings no stale open`, async () => {
        if (kind === 'direct') directStore.set({ loaded: true, machines: [DIRECT] });
        const shell = await onMachines();
        let release!: () => void;
        vi.mocked(SecureStore.set).mockImplementationOnce(() => new Promise<void>((r) => (release = r)));
        fireEvent.click(await screen.findByText(kind === 'org' ? 'box' : 'direct-box'));
        await waitFor(() => expect(SecureStore.set).toHaveBeenCalled());
        // Opened already, with the write still out.
        expect(opens()).toHaveLength(1);
        if (newer === 'an agent link') {
          act(() => listener<{ url: string }>(vi.mocked(CapApp.addListener), 'appUrlOpen')({ url: linkB }));
          await waitFor(() => expect(opens().at(-1)).toMatchObject({ route: '#/agent/newer' }));
        }
        if (newer === 'Settings') act(() => navigate({ name: 'settings' }));
        if (newer === 'teardown') shell.unmount();
        await act(async () => release());
        await tick();
        expect(opens()).toHaveLength(newer === 'an agent link' ? 2 : 1);
        if (newer === 'an agent link') expect(opens().at(-1)).toMatchObject({ route: '#/agent/newer' });
        if (newer === 'Settings') expect(window.location.hash).toBe('#/settings');
        // The tap is still remembered, once its write lands.
        expect(settingsStore.get().lastMachine).toEqual(kind === 'org' ? { orgId: ORG, machineId: M, host: 'box.example.com' } : { directId: 'direct' });
      });
    }

    it(`${kind}: a remember write that fails still opens, and remembers nothing`, async () => {
      if (kind === 'direct') directStore.set({ loaded: true, machines: [DIRECT] });
      await onMachines();
      vi.mocked(SecureStore.set).mockRejectedValueOnce(Object.assign(new Error('full'), { code: 'native_error' }));
      fireEvent.click(await screen.findByText(kind === 'org' ? 'box' : 'direct-box'));
      await waitFor(() => expect(opens()).toHaveLength(1));
      await tick();
      expect(settingsStore.get().lastMachine).toBeNull();
    });
  }
});

describe('Keep and open carries its own claim to the native open', () => {
  const HOST = 'kept.example.com';
  const NEW = { kind: 'yaran' as const, instance: 'new', passwordSet: false, requiredHere: false, signedIn: false, transportEncrypted: true };
  async function keepPressed() {
    directStore.set({ loaded: true, machines: [{ id: 'kept', label: 'kept-box', host: HOST, instance: 'old', addedAt: 'x', routes: [{ kind: 'direct', host: HOST }] }] });
    const shell = await onMachines();
    act(() => listener<unknown>(vi.mocked(MachineView.addListener), 'closed')({ reason: 'error', code: 'instance_changed', host: HOST, requestedHost: HOST }));
    let answer!: () => void;
    vi.mocked(Session.routeStatus).mockImplementationOnce(() => new Promise((r) => (answer = () => r(NEW))));
    fireEvent.click(await screen.findByRole('button', { name: 'Keep and open' }));
    await waitFor(() => expect(Session.routeStatus).toHaveBeenCalled());
    return { shell, answer: () => answer() };
  }
  const keptOpens = () => opens().filter((o) => o.host === HOST);
  const keptInstance = () => directStore.get().machines.find((m) => m.id === 'kept')?.instance;

  it.each(['Settings', 'teardown', 'successful undo'])('a Keep save across %s reports only a retained identity', async (ending) => {
    const keep = await keepPressed();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    vi.mocked(SecureStore.set).mockImplementationOnce(async (options) => { await gate; return writeStore(options); });
    if (ending !== 'successful undo') vi.mocked(SecureStore.set).mockRejectedValueOnce({ code: 'unavailable' });
    await act(async () => keep.answer());
    await waitFor(() => expect(SecureStore.set).toHaveBeenCalled());
    if (ending === 'teardown') keep.shell.unmount();
    else act(() => navigate({ name: 'settings' }));
    await act(async () => { release(); });
    await tick();
    const saved = await SecureStore.get({ namespace: 'direct', key: 'list' });
    expect(JSON.parse(saved.value!)[0].instance).toBe(ending === 'successful undo' ? 'old' : 'new');
    expect(keptInstance()).toBe(ending === 'successful undo' ? 'old' : 'new');
    expect(keptOpens()).toEqual([]);
    if (ending === 'successful undo') expect(toast.error).not.toHaveBeenCalled();
    else {
      expect(toast.error).toHaveBeenCalledOnce();
      renderShell(<>{vi.mocked(toast.error).mock.calls[0]![0]}</>);
      expect(screen.getByText('rollback_failed')).toBeTruthy();
      expect(screen.getByText(/new identity is still saved/)).toBeTruthy();
    }
    keep.shell.unmount();
  });

  it('Settings while the check is out: the kept machine neither saves nor opens', async () => {
    const keep = await keepPressed();
    act(() => navigate({ name: 'settings' }));
    await act(async () => keep.answer());
    await tick();
    expect(keptOpens()).toEqual([]);
    expect(keptInstance()).toBe('old');
  });

  it('a newer machine opened from the list (no address change) wins', async () => {
    const keep = await keepPressed();
    fireEvent.click(await screen.findByText('newer-box'));
    await waitFor(() => expect(opens()).toEqual([expect.objectContaining({ machineId: B })]));
    await act(async () => keep.answer());
    await tick();
    expect(opens()).toEqual([expect.objectContaining({ machineId: B })]);
    expect(keptInstance()).toBe('old');
  });

  it('a newer agent link (no address change) wins', async () => {
    const keep = await keepPressed();
    act(() => listener<{ url: string }>(vi.mocked(CapApp.addListener), 'appUrlOpen')({ url: linkB }));
    await waitFor(() => expect(opens()).toEqual([expect.objectContaining({ route: '#/agent/newer' })]));
    await act(async () => keep.answer());
    await tick();
    expect(keptOpens()).toEqual([]);
  });

  it('the App torn down while the check is out: nothing saves or opens', async () => {
    const keep = await keepPressed();
    keep.shell.unmount();
    await act(async () => keep.answer());
    await tick();
    expect(keptOpens()).toEqual([]);
    expect(keptInstance()).toBe('old');
  });

  it('a newer machine opened while the identity write is out: the write is undone and the kept machine never opens', async () => {
    const keep = await keepPressed();
    let release!: () => void;
    vi.mocked(SecureStore.set).mockImplementationOnce(() => new Promise<void>((r) => (release = r)));
    await act(async () => keep.answer());
    await waitFor(() => expect(SecureStore.set).toHaveBeenCalled());
    fireEvent.click(await screen.findByText('newer-box'));
    await waitFor(() => expect(opens()).toEqual([expect.objectContaining({ machineId: B })]));
    await act(async () => release());
    await tick();
    expect(keptOpens()).toEqual([]);
    expect(keptInstance()).toBe('old');
  });

  it('control: undisturbed, Keep saves the new identity and opens the machine', async () => {
    const keep = await keepPressed();
    await act(async () => keep.answer());
    await waitFor(() => expect(keptOpens()).toHaveLength(1));
    expect(keptInstance()).toBe('new');
  });
});

describe('a pending agent link or notification Open gives way to a newer manual choice or screen', () => {
  const linkA = agentLinkUrl('apps.example.org', { target: { kind: 'org', orgUrl: ORG, machineId: M }, agentId: 'older' });
  const UNLOCKED = { enabled: false, allowPasscode: false, grace: '1min' as const, locked: false, biometry: 'available' as const };

  for (const newer of ['a manual Open', 'Settings', 'nothing (control)'] as const) {
    it(`agent link A with its lock read held, then ${newer}`, async () => {
      await onMachines();
      let release!: () => void;
      vi.mocked(AppLock.status).mockImplementationOnce(() => new Promise((r) => (release = () => r(UNLOCKED))));
      act(() => listener<{ url: string }>(vi.mocked(CapApp.addListener), 'appUrlOpen')({ url: linkA }));
      await tick();
      expect(opens()).toEqual([]);
      if (newer === 'a manual Open') fireEvent.click(await screen.findByText('newer-box'));
      if (newer === 'Settings') act(() => navigate({ name: 'settings' }));
      await act(async () => release());
      await tick();
      if (newer === 'a manual Open') expect(opens()).toEqual([expect.objectContaining({ machineId: B })]);
      if (newer === 'Settings') {
        expect(opens()).toEqual([]);
        expect(window.location.hash).toBe('#/settings');
      }
      if (newer === 'nothing (control)') expect(opens()).toEqual([expect.objectContaining({ machineId: M, route: '#/agent/older' })]);
    });
  }

  for (const newer of ['a manual Open', 'Settings', 'nothing (control)'] as const) {
    it(`cold notification Open A with its list refresh held, then ${newer}`, async () => {
      directStore.set({ loaded: true, machines: [DIRECT] });
      await onMachines();
      const listed = machinesStore.get()[ORG]!.machines;
      machinesStore.set({});
      let release!: () => void;
      vi.mocked(Session.request).mockImplementationOnce(() => new Promise((r) => (release = () => r({ kind: 'ok', status: 200, body: { items: listed, next_cursor: null } }))));
      vi.mocked(Push.clearDelivered).mockClear();
      for (const t of Object.values(toast)) vi.mocked(t).mockClear();
      act(() => listener<unknown>(vi.mocked(Push.addListener), 'notificationTapped')({ orgId: ORG, machineId: M, agentId: 'older', action: 'open' }));
      await tick();
      expect(opens()).toEqual([]);
      if (newer === 'a manual Open') fireEvent.click(await screen.findByText('direct-box'));
      if (newer === 'Settings') act(() => navigate({ name: 'settings' }));
      await act(async () => release());
      await tick();
      if (newer === 'nothing (control)') {
        expect(opens()).toEqual([expect.objectContaining({ machineId: M })]);
        expect(Push.clearDelivered).toHaveBeenCalledTimes(1);
        return;
      }
      // The stale tap ends without a word: no open, the alert kept, no "no longer paired" warning.
      expect(opens()).toEqual(newer === 'a manual Open' ? [expect.objectContaining({ host: DIRECT.host })] : []);
      expect(Push.clearDelivered).not.toHaveBeenCalled();
      expect(toast.info).not.toHaveBeenCalled();
      if (newer === 'Settings') expect(window.location.hash).toBe('#/settings');
    });
  }

  it('a link released after an unlock gives way to a manual Open made while its lock read is out', async () => {
    vi.mocked(AppLock.status).mockResolvedValue({ ...UNLOCKED, enabled: true, locked: true });
    await onMachines();
    act(() => listener<{ url: string }>(vi.mocked(CapApp.addListener), 'appUrlOpen')({ url: linkA }));
    await tick();
    expect(opens()).toEqual([]);
    let release!: () => void;
    vi.mocked(AppLock.status).mockImplementationOnce(() => new Promise((r) => (release = () => r(UNLOCKED))));
    vi.mocked(AppLock.status).mockResolvedValue(UNLOCKED);
    act(() => listener<{ locked: boolean }>(vi.mocked(AppLock.addListener), 'lockStateChanged')({ locked: false }));
    await waitFor(() => expect(release).toBeTypeOf('function'));
    fireEvent.click(await screen.findByText('newer-box'));
    await act(async () => release());
    await tick();
    expect(opens()).toEqual([expect.objectContaining({ machineId: B })]);
  });
});
