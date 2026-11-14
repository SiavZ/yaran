/**
 * Lingui setup and the language switch for the shell.
 *
 * Catalogs are `.po` files compiled on import by the Lingui Vite plugin; English is the
 * source and the only shipped locale today. The chosen locale is a shell setting.
 *
 * - `activate` is synchronous: every catalog is bundled (no network, CSP).
 *
 * <module-headers:begin>
 * Uses: none
 * External: @lingui/core
 *
 * Used by:
 * src/lib/i18n.ts
 * ├── src/i18n.test.ts
 * ├── src/lib/api.test.ts
 * ├── src/main.tsx
 * ├── src/screens/machines/machines.test.tsx
 * ├── src/screens/settings/LanguageSettings.tsx
 * ├── src/test/render.tsx
 * └── src/test/setup.ts
 * <module-headers:end>
 */
import { i18n, type Messages } from '@lingui/core';

import { messages as en } from '../locales/en/messages.po';

export const LOCALES = { en: 'English' } as const;
export type Locale = keyof typeof LOCALES;
export const DEFAULT_LOCALE: Locale = 'en';

const catalogs: Record<Locale, Messages> = { en };

export function isLocale(value: string): value is Locale {
  return Object.hasOwn(LOCALES, value);
}

export function activate(locale: Locale): void {
  i18n.load(locale, catalogs[locale]);
  i18n.activate(locale);
  if (typeof document !== 'undefined') document.documentElement.lang = locale;
}

export { i18n };
