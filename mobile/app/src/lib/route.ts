/**
 * The shell's hash routes: pure parse and build.
 *
 * The URL hash is the position; screens navigate by building a route, never relatively.
 * Unknown or malformed hashes parse to `null` and the app falls back to its home screen.
 *
 * - Pure. The `u` parameter of `confirm` is untrusted (it can come from a deep link or QR)
 *   and is re-checked by the host rules on the Confirm org screen.
 *
 * <module-headers:begin>
 * Uses:
 * src/lib/route.ts
 * └── src/lib/assertNever.ts
 * External: react
 *
 * Used by:
 * src/lib/route.ts
 * ├── src/App.tsx
 * ├── src/a11y.test.tsx
 * ├── src/lib/deepLinks.test.ts
 * ├── src/lib/deepLinks.ts
 * ├── src/lib/route.test.ts
 * ├── src/screens/Nav.tsx
 * ├── src/screens/machines/MachineList.tsx
 * ├── src/screens/machines/machines.test.tsx
 * ├── src/screens/machines/states/Empty.tsx
 * ├── src/screens/machines/states/PhoneRemoved.tsx
 * ├── src/screens/onboarding/ConfirmOrg.tsx
 * ├── src/screens/onboarding/EnterUrl.tsx
 * ├── src/screens/onboarding/ScanQr.tsx
 * ├── src/screens/onboarding/SignInResult.tsx
 * ├── src/screens/onboarding/Welcome.tsx
 * ├── src/screens/onboarding/onboarding.test.tsx
 * ├── src/screens/orgs/OrgList.tsx
 * ├── src/screens/screens.test.tsx
 * ├── src/screens/settings/Settings.tsx
 * └── src/test/routes.ts
 * <module-headers:end>
 */
import { useSyncExternalStore } from 'react';

import { assertNever } from './assertNever.ts';

export type SettingsPage = 'security' | 'language' | 'diagnostics' | 'licenses';

export type Route =
  | { name: 'welcome' }
  | { name: 'scan' }
  | { name: 'enter-url' }
  | { name: 'confirm'; url: string }
  | { name: 'machines' }
  | { name: 'orgs' }
  | { name: 'settings' }
  | { name: 'settings-page'; page: SettingsPage }
  | { name: 'removed'; org: string };

const SETTINGS_PAGES: readonly SettingsPage[] = ['security', 'language', 'diagnostics', 'licenses'];

export function buildRoute(route: Route): string {
  switch (route.name) {
    case 'welcome':
    case 'scan':
    case 'enter-url':
    case 'machines':
    case 'orgs':
    case 'settings':
      return `#/${route.name}`;
    case 'confirm':
      return `#/confirm?u=${encodeURIComponent(route.url)}`;
    case 'settings-page':
      return `#/settings/${route.page}`;
    case 'removed':
      return `#/removed?org=${encodeURIComponent(route.org)}`;
    default:
      return assertNever(route);
  }
}

export function parseRoute(hash: string): Route | null {
  const m = /^#\/([a-z-]+)(?:\/([a-z]+))?(?:\?(.*))?$/.exec(hash);
  if (!m) return null;
  const [, head, sub, query] = m;
  const params = new URLSearchParams(query ?? '');
  if (sub !== undefined) {
    return head === 'settings' && (SETTINGS_PAGES as readonly string[]).includes(sub) ? { name: 'settings-page', page: sub as SettingsPage } : null;
  }
  switch (head) {
    case 'welcome':
    case 'scan':
    case 'enter-url':
    case 'machines':
    case 'orgs':
    case 'settings':
      return { name: head };
    case 'confirm': {
      const url = params.get('u');
      return url === null || url === '' ? null : { name: 'confirm', url };
    }
    case 'removed': {
      const org = params.get('org');
      return org === null ? null : { name: 'removed', org };
    }
    default:
      return null;
  }
}

/** Moves to a route: a new position pushes, so Back always visibly moves. */
export function navigate(route: Route, { replace = false } = {}): void {
  const hash = buildRoute(route);
  if (!replace) {
    window.location.hash = hash;
    return;
  }
  // replaceState fires no hashchange, so announce the move to useRoute ourselves.
  window.history.replaceState(null, '', hash);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

function subscribe(listener: () => void): () => void {
  window.addEventListener('hashchange', listener);
  return () => window.removeEventListener('hashchange', listener);
}

/** The current route, or null when the hash names none. */
export function useRoute(): Route | null {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  return parseRoute(hash);
}
