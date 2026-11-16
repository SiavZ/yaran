/**
 * Entry point of the phone app shell, loaded by `index.html` inside the Capacitor WebView.
 *
 * Opts into the dark token set (the web and the shared tokens are dark-only), loads the
 * saved settings and org list from the vault, activates the saved language, then mounts.
 *
 * - The shell never touches the network; everything here is local.
 *
 * <module-headers:begin>
 * Uses:
 * src/main.tsx
 * ├── src/App.tsx
 * ├── src/lib/i18n.ts
 * ├── src/lib/orgStore.ts
 * └── src/lib/settingsStore.ts
 * External: @lingui/react, react, react-dom
 *
 * Used by: entry point (loaded by mobile/app/index.html inside the Capacitor WebView)
 * <module-headers:end>
 */
import { I18nProvider } from '@lingui/react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import './index.css';
import { App } from './App.tsx';
import { DEFAULT_LOCALE, activate, i18n, isLocale } from './lib/i18n.ts';
import { loadOrgs } from './lib/orgStore.ts';
import { loadSettings } from './lib/settingsStore.ts';

document.documentElement.classList.add('dark');
document.documentElement.style.colorScheme = 'dark';

const settings = await loadSettings().catch(() => null);
activate(settings && isLocale(settings.locale) ? settings.locale : DEFAULT_LOCALE);
await loadOrgs();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider i18n={i18n}>
      <App />
    </I18nProvider>
  </StrictMode>,
);
