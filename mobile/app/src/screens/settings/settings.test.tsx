/**
 * DOM tests for the settings screens.
 *
 * Covers: enabling the lock calls `AppLock.enable` and confirms the outcome; an invalidated
 * lock shows the wiped-sessions sentence; erase confirms, wipes and confirms; the licenses
 * page renders the generated lists; the releases link exists only in `foss` and points
 * exactly at the canonical repository; diagnostics previews before export.
 *
 * <module-headers:begin>
 * Uses:
 * src/screens/settings/settings.test.tsx
 * ├── @yaran/secure-store:src/index.ts
 * ├── src/App.tsx
 * ├── src/lib/buildInfo.ts
 * ├── src/lib/orgStore.ts
 * ├── src/lib/settingsStore.ts
 * ├── src/screens/settings/Diagnostics.tsx
 * ├── src/screens/settings/Licenses.tsx
 * ├── src/screens/settings/LockScreen.tsx
 * ├── src/screens/settings/SecuritySettings.tsx
 * ├── src/screens/settings/Settings.tsx
 * ├── src/test/render.tsx
 * └── src/test/setup.ts
 * External: @testing-library/react, sonner, vitest
 *
 * Used by: entry point (vitest, via npm test in mobile/app)
 * <module-headers:end>
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { AppLock, BuildInfo, Diagnostics as DiagnosticsLog, ScreenPrivacy, SecureStore } from '@yaran/secure-store';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resetBuildInfoForTests } from '../../lib/buildInfo.ts';
import { DEFAULT_SETTINGS, settingsStore } from '../../lib/settingsStore.ts';
import { App } from '../../App.tsx';
import { vault } from '../../test/setup.ts';
import { orgStore } from '../../lib/orgStore.ts';
import { renderShell } from '../../test/render.tsx';
import { Diagnostics } from './Diagnostics.tsx';
import { Licenses, RELEASES_URL } from './Licenses.tsx';
import { LockScreen } from './LockScreen.tsx';
import { SecuritySettings } from './SecuritySettings.tsx';
import { Settings } from './Settings.tsx';

vi.mock('sonner', async (orig) => ({
  ...(await orig<typeof import('sonner')>()),
  toast: { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn(), loading: vi.fn() },
}));

beforeEach(resetBuildInfoForTests);

it.each([false, true])('a failed explicit reopen preference keeps %s, explains why and can be retried', async (initial) => {
  orgStore.set({ loaded: true, orgs: [] });
  settingsStore.set({ ...DEFAULT_SETTINGS, reopenLastMachine: initial });
  vault.set('settings/shell', JSON.stringify(settingsStore.get()));
  window.location.hash = '#/settings';
  renderShell(<App />);
  const control = screen.getByRole('switch', { name: 'Reopen last machine on launch' });
  vi.mocked(SecureStore.set).mockRejectedValueOnce({ code: 'unavailable', message: 'private diagnostic' });
  fireEvent.click(control);
  await waitFor(() => expect(toast.error).toHaveBeenCalledOnce());
  expect(control.getAttribute('aria-checked')).toBe(String(initial));
  expect(settingsStore.get().reopenLastMachine).toBe(initial);
  expect(JSON.parse(vault.get('settings/shell')!).reopenLastMachine).toBe(initial);
  const error = renderShell(<>{vi.mocked(toast.error).mock.calls[0]![0]}</>).container.textContent;
  expect(error).toMatch(/couldn't be saved.*unavailable.*previous value.*Try again/);
  expect(error).not.toContain('private diagnostic');
  fireEvent.click(control);
  await waitFor(() => expect(control.getAttribute('aria-checked')).toBe(String(!initial)));
  expect(JSON.parse(vault.get('settings/shell')!).reopenLastMachine).toBe(!initial);
});

describe('SecuritySettings', () => {
  it.each(['lock', 'privacy'])('explains an unreadable initial %s state and leaves that control disabled', async (kind) => {
    if (kind === 'lock') vi.mocked(AppLock.status).mockRejectedValueOnce({ code: 'unavailable' });
    else vi.mocked(ScreenPrivacy.get).mockRejectedValueOnce({ code: 'unavailable' });
    renderShell(<SecuritySettings />);
    await waitFor(() => expect(toast.error).toHaveBeenCalledOnce());
    const control = screen.getByRole('switch', { name: kind === 'lock' ? 'App lock' : 'Hide screen content' });
    expect(control.hasAttribute('disabled') || control.getAttribute('aria-disabled') === 'true').toBe(true);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it.each(['enable', 'disable', 'privacy', 'status after enable', 'status after options'])('explains a rejected %s and keeps confirmed state', async (action) => {
    const initial = { enabled: action === 'disable', allowPasscode: false, grace: '1min' as const, locked: false, biometry: 'available' as const };
    const failure = { code: 'unavailable', message: 'private diagnostic text' };
    vi.mocked(AppLock.status).mockResolvedValue(initial);
    vi.mocked(ScreenPrivacy.get).mockResolvedValue({ enabled: false });
    renderShell(<SecuritySettings />);
    const control = await screen.findByRole('switch', { name: action === 'privacy' ? 'Hide screen content' : action === 'status after options' ? 'Allow device passcode' : 'App lock' });
    await waitFor(() => expect(control.hasAttribute('disabled')).toBe(false));
    if (action === 'enable') vi.mocked(AppLock.enable).mockRejectedValueOnce(failure);
    if (action === 'disable') vi.mocked(AppLock.disable).mockRejectedValueOnce(failure);
    if (action === 'privacy') vi.mocked(ScreenPrivacy.set).mockRejectedValueOnce(failure);
    if (action.startsWith('status')) vi.mocked(AppLock.status).mockRejectedValueOnce(failure);
    fireEvent.click(control);
    await waitFor(() => expect(toast.error).toHaveBeenCalledOnce());
    expect(control.getAttribute('aria-checked')).toBe(action === 'disable' ? 'true' : 'false');
    expect(toast.success).not.toHaveBeenCalled();
    renderShell(<>{vi.mocked(toast.error).mock.calls[0]![0]}</>);
    expect(screen.getByText('unavailable')).toBeTruthy();
    expect(screen.queryByText(/private diagnostic text/)).toBeNull();
  });

  it('enabling the lock calls AppLock.enable and confirms the outcome', async () => {
    renderShell(<SecuritySettings />);
    const lock = await screen.findByRole('switch', { name: 'App lock' });
    await waitFor(() => expect(lock.getAttribute('aria-disabled') ?? lock.hasAttribute('disabled') ? 'x' : '').not.toBe('x'));
    fireEvent.click(lock);
    await waitFor(() => expect(AppLock.enable).toHaveBeenCalledWith({ allowPasscode: false }));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });
  it('a cancelled prompt leaves the lock off and says so', async () => {
    vi.mocked(AppLock.enable).mockResolvedValueOnce({ outcome: 'cancelled' });
    renderShell(<SecuritySettings />);
    fireEvent.click(await screen.findByRole('switch', { name: 'App lock' }));
    await waitFor(() => expect(toast.info).toHaveBeenCalled());
  });
});

describe('lock options', () => {
  it('a refused option change is explained, not swallowed', async () => {
    vi.mocked(AppLock.setOptions).mockRejectedValueOnce({ code: 'invalid_argument' });
    renderShell(<SecuritySettings />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Allow device passcode' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
  });
});

describe('LockScreen', () => {
  it('an unlock ending after teardown does not invoke the retired callback', async () => {
    let resolve!: (answer: { outcome: 'unlocked' }) => void;
    vi.mocked(AppLock.unlock).mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    const onUnlocked = vi.fn();
    const view = renderShell(<LockScreen onUnlocked={onUnlocked} />);
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    view.unmount();
    await act(async () => { resolve({ outcome: 'unlocked' }); });
    expect(onUnlocked).not.toHaveBeenCalled();
  });

  it('explains a rejected unlock without leaving the lock screen or exposing raw diagnostics', async () => {
    const unlocked = vi.fn();
    vi.mocked(AppLock.unlock).mockRejectedValueOnce({ code: 'token=private', message: 'private diagnostic text' });
    renderShell(<LockScreen onUnlocked={unlocked} />);
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('unknown');
    expect(alert.textContent).not.toMatch(/token=private|private diagnostic text/);
    expect(unlocked).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Unlock' })).toBeTruthy();
  });

  it('an invalidated lock shows the wiped-sessions sentence', async () => {
    vi.mocked(AppLock.unlock).mockResolvedValueOnce({ outcome: 'invalidated' });
    renderShell(<LockScreen onUnlocked={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/deleted its sign-ins/);
  });
  it('unlocks', async () => {
    const onUnlocked = vi.fn();
    renderShell(<LockScreen onUnlocked={onUnlocked} />);
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    await waitFor(() => expect(onUnlocked).toHaveBeenCalled());
  });
});

describe('Erase everything', () => {
  it('confirms with Cancel focused, then wipes and confirms', async () => {
    orgStore.set({ loaded: true, orgs: [{ id: 'https://cp.example.com', name: 'Ada', teamDomain: null, addedAt: 'x' }] });
    renderShell(<Settings />);
    fireEvent.click(screen.getByRole('button', { name: /Erase everything on this phone/ }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' })));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Erase everything' }));
    await waitFor(() => expect(SecureStore.eraseAll).toHaveBeenCalled());
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(orgStore.get().orgs).toEqual([]);
  });
});

describe('Licenses', () => {
  it('shows the releases link only in foss, pointing at the canonical repository', async () => {
    const { unmount } = renderShell(<Licenses />);
    const link = await screen.findByRole('link', { name: 'Releases on GitHub' });
    expect(link.getAttribute('href')).toBe('https://github.com/SiavZ/yaran/releases');
    expect(RELEASES_URL).toBe('https://github.com/SiavZ/yaran/releases');
    unmount();
    resetBuildInfoForTests();
    vi.mocked(BuildInfo.get).mockResolvedValueOnce({ flavor: 'play', e2e: false, e2eControlPlaneUrl: '' });
    renderShell(<Licenses />);
    await waitFor(() => expect(BuildInfo.get).toHaveBeenCalled());
    await Promise.resolve();
    expect(screen.queryByRole('link', { name: 'Releases on GitHub' })).toBeNull();
  });
  it('renders the generated lists', () => {
    renderShell(<Licenses />);
    expect(screen.getByRole('heading', { name: 'App interface' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Native components' })).toBeTruthy();
  });
});

describe('Diagnostics', () => {
  it('previews the log, warns about host names, and exports', async () => {
    renderShell(<Diagnostics />);
    expect(await screen.findByText(/opened machines/)).toBeTruthy();
    expect(screen.getByText(/host names/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Export…' }));
    await waitFor(() => expect(DiagnosticsLog.export).toHaveBeenCalled());
  });
});
