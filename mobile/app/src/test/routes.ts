/**
 * Every shell route, for tests that must cover each screen (banner, accessibility).
 *
 * - A new route that is not listed here is caught by the route round-trip test's exhaustive build.
 *
 * <module-headers:begin>
 * Uses:
 * src/test/routes.ts
 * └── src/lib/route.ts
 * External: none
 *
 * Used by:
 * src/test/routes.ts
 * ├── src/a11y.test.tsx
 * └── src/screens/screens.test.tsx
 * <module-headers:end>
 */
import type { Route } from '../lib/route.ts';

export const ALL_ROUTES: Route[] = [
  { name: 'welcome' },
  { name: 'scan' },
  { name: 'enter-url' },
  { name: 'confirm', url: 'https://cp.example.com' },
  { name: 'machines' },
  { name: 'orgs' },
  { name: 'settings' },
  { name: 'settings-page', page: 'security' },
  { name: 'settings-page', page: 'language' },
  { name: 'settings-page', page: 'diagnostics' },
  { name: 'settings-page', page: 'licenses' },
  { name: 'removed', org: 'Ada Org' },
];
