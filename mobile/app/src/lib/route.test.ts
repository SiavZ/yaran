/**
 * Round-trip and refusal tests for the hash routes.
 *
 * <module-headers:begin>
 * Uses:
 * src/lib/route.test.ts
 * └── src/lib/route.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test in mobile/app)
 * <module-headers:end>
 */
import { describe, expect, it } from 'vitest';

import { buildRoute, parseRoute, type Route } from './route.ts';

const routes: Route[] = [
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
  { name: 'removed', org: 'Ada & Co <x>' },
];

describe('routes', () => {
  for (const r of routes) {
    it(`round-trips ${JSON.stringify(r)}`, () => expect(parseRoute(buildRoute(r))).toEqual(r));
  }
  it.each(['', '#', '#/nope', '#/settings/nope', '#/confirm', '#/confirm?u=', '#/machines/extra', 'machines'])('refuses %j', (h) => {
    expect(parseRoute(h)).toBeNull();
  });
});
