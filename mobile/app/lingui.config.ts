/**
 * Lingui configuration for the phone app shell (work item 12).
 *
 * English is the source and the only shipped locale today; the catalog lives in
 * `src/locales/<locale>/messages.po`, extracted from the Lingui macros in `src/`.
 *
 * - `lingui extract --clean` must leave the catalog unchanged (checked by `src/i18n.test.ts`,
 *   which sets `LINGUI_CATALOG_PATH` to a temp copy).
 *
 * <module-headers:begin>
 * Uses: none
 * External: @lingui/conf, @lingui/format-po
 *
 * Used by: entry point (read by vite/vitest, the Lingui CLI and the Capacitor CLI in mobile/app)
 * <module-headers:end>
 */
import { defineConfig } from '@lingui/conf';
import { formatter } from '@lingui/format-po';

/** The catalog location; the i18n test points a temp config at a copy to check for drift. */
export const CATALOG_PATH = process.env.LINGUI_CATALOG_PATH ?? '<rootDir>/src/locales/{locale}/messages';

export default defineConfig({
  sourceLocale: 'en',
  locales: ['en'],
  // No source line numbers in the catalog, so moving code does not churn the .po file.
  format: formatter({ origins: false }),
  catalogs: [{ path: CATALOG_PATH, include: ['<rootDir>/src'], exclude: ['**/*.test.*', '**/src/test/**'] }],
});
