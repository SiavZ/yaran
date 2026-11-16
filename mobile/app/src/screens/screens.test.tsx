/**
 * App-level tests: the route switch and the development-build banner.
 *
 * The banner must render on every route when `Session.callbackMode()` is `dev` and never when
 * it is `https` (D8, T36); the lock screen replaces every screen while locked.
 *
 * <module-headers:begin>
 * Uses:
 * src/screens/screens.test.tsx
 * ├── @yaran/secure-store:src/index.ts
 * ├── src/App.tsx
 * ├── src/lib/buildInfo.ts
 * ├── src/lib/native/machineView.ts
 * ├── src/lib/orgStore.ts
 * ├── src/lib/route.ts
 * ├── src/test/render.tsx
 * └── src/test/routes.ts
 * External: @testing-library/react, vitest
 *
 * Used by: entry point (vitest, via npm test in mobile/app)
 * <module-headers:end>
 */
import { act, screen, waitFor } from '@testing-library/react';
import { AppLock } from '@yaran/secure-store';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../App.tsx';
import { resetBuildInfoForTests } from '../lib/buildInfo.ts';
import { Session } from '../lib/native/machineView.ts';
import { orgStore } from '../lib/orgStore.ts';
import { buildRoute } from '../lib/route.ts';
import { renderShell } from '../test/render.tsx';
import { ALL_ROUTES } from '../test/routes.ts';

beforeEach(() => {
  resetBuildInfoForTests();
  orgStore.set({ loaded: true, orgs: [] });
  vi.mocked(Session.meta).mockReturnValue(new Promise(() => {}));
});

describe('development-build banner', () => {
  for (const route of ALL_ROUTES) {
    it(`shows on ${route.name}${'page' in route ? `/${route.page}` : ''} in a dev build`, async () => {
      vi.mocked(Session.callbackMode).mockResolvedValue({ mode: 'dev' });
      window.location.hash = buildRoute(route);
      renderShell(<App />);
      expect(await screen.findByTestId('dev-build-banner')).toBeTruthy();
    });
  }
  it('never shows in a build with a publisher domain', async () => {
    vi.mocked(Session.callbackMode).mockResolvedValue({ mode: 'https', domain: 'apps.example.org' });
    for (const route of ALL_ROUTES) {
      window.location.hash = buildRoute(route);
      const { unmount } = renderShell(<App />);
      await act(async () => {});
      expect(screen.queryByTestId('dev-build-banner')).toBeNull();
      unmount();
    }
  });
  it('treats an unreadable callback mode as a dev build', async () => {
    vi.mocked(Session.callbackMode).mockRejectedValue(new Error('unavailable'));
    renderShell(<App />);
    expect(await screen.findByTestId('dev-build-banner')).toBeTruthy();
  });
});

describe('routing', () => {
  it('starts on Welcome with no org and on Machines with one', async () => {
    renderShell(<App />);
    expect(await screen.findByRole('heading', { name: 'Welcome to yaran' })).toBeTruthy();
  });
  it('shows the lock screen instead of any screen while locked', async () => {
    vi.mocked(AppLock.status).mockResolvedValueOnce({ enabled: true, allowPasscode: false, grace: '1min', locked: true, biometry: 'available' });
    window.location.hash = buildRoute({ name: 'settings' });
    renderShell(<App />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'yaran is locked' })).toBeTruthy());
    expect(screen.queryByRole('heading', { name: 'Settings' })).toBeNull();
  });
});
