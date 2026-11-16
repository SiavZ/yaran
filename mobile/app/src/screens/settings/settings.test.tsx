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
 * ├── src/lib/buildInfo.ts
 * ├── src/lib/orgStore.ts
 * ├── src/screens/settings/Diagnostics.tsx
 * ├── src/screens/settings/Licenses.tsx
 * ├── src/screens/settings/LockScreen.tsx
 * ├── src/screens/settings/SecuritySettings.tsx
 * ├── src/screens/settings/Settings.tsx
 * └── src/test/render.tsx
 * External: @testing-library/react, sonner, vitest
 *
 * Used by: entry point (vitest, via npm test in mobile/app)
 * <module-headers:end>
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { AppLock, BuildInfo, Diagnostics as DiagnosticsLog, SecureStore } from '@yaran/secure-store';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resetBuildInfoForTests } from '../../lib/buildInfo.ts';
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

describe('SecuritySettings', () => {
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
    await waitFor(() => expect(toast.warning).toHaveBeenCalled());
  });
});

describe('LockScreen', () => {
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
