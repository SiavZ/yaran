/**
 * Incoming `yaranapp://` links: validation and routing.
 *
 * `yaranapp://add-org?u=<org url>` can be fired by any app or web page (T42), so it always
 * lands on Confirm org with the URL shown as a chip, never added automatically. `home` and
 * `settings` navigate; `reauth` belongs to machine-view (Phase 15) and is ignored here;
 * anything else is refused with a toast and a diagnostics line.
 *
 * - The org URL passes the protocol grammar and then the host rules before it is shown.
 *
 * <module-headers:begin>
 * Uses:
 * src/lib/deepLinks.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/lib/diagnostics.ts
 * ├── src/lib/notify.ts
 * ├── src/lib/orgUrl.ts
 * └── src/lib/route.ts
 * External: @capacitor/app, @lingui/core
 *
 * Used by:
 * src/lib/deepLinks.ts
 * ├── src/lib/deepLinks.test.ts
 * └── src/lib/lifecycle.ts
 * <module-headers:end>
 */
import { App } from '@capacitor/app';
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { parseAppUri } from '@yaran/protocol';

import { log } from './diagnostics.ts';
import { notify } from './notify.ts';
import { normalizeTypedOrgUrl } from './orgUrl.ts';
import { navigate, type Route } from './route.ts';

/** Where a link leads, or null when the shell ignores it. Pure apart from logging. */
export function routeForAppUrl(url: string): Route | 'refused' | null {
  const parsed = parseAppUri(url);
  if (!parsed.ok) return 'refused';
  switch (parsed.kind) {
    case 'add-org': {
      const org = normalizeTypedOrgUrl(parsed.orgUrl);
      return org.ok ? { name: 'confirm', url: org.value } : 'refused';
    }
    case 'home':
      return { name: 'machines' };
    case 'settings':
      return { name: 'settings' };
    case 'reauth':
      return null;
  }
}

export function handleAppUrl(url: string): void {
  const target = routeForAppUrl(url);
  if (target === null) return;
  if (target === 'refused') {
    log('warn', 'refused an incoming link that is not a valid yaranapp link');
    notify('warning', i18n._(msg`That link isn't a yaran link this app can open, so it was ignored.`));
    return;
  }
  navigate(target);
}

/** Wires the launch URL and later `appUrlOpen` events; returns the unsubscribe. */
export async function installDeepLinks(): Promise<() => void> {
  const launch = await App.getLaunchUrl().catch(() => undefined);
  if (launch?.url) handleAppUrl(launch.url);
  const handle = await App.addListener('appUrlOpen', (e) => handleAppUrl(e.url));
  return () => void handle.remove();
}
