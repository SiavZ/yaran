/**
 * Accessibility checks on every screen: axe-core, accessible names and the 40 px floor.
 *
 * Renders each route through the real App and runs axe, whose name rules (button-name,
 * link-name, label) cover accessible names; color contrast is skipped because jsdom has no
 * layout or computed colors. Every button, link and form control must also carry a 40 px
 * sizing class on itself or its row; jsdom cannot measure, so the size check is class-based
 * (the device check is Phase 19's).
 *
 * <module-headers:begin>
 * Uses:
 * src/a11y.test.tsx
 * ├── src/App.tsx
 * ├── src/lib/buildInfo.ts
 * ├── src/lib/native/machineView.ts
 * ├── src/lib/orgStore.ts
 * ├── src/lib/route.ts
 * ├── src/test/render.tsx
 * └── src/test/routes.ts
 * External: @testing-library/react, axe-core, vitest
 *
 * Used by: entry point (vitest, via npm test in mobile/app)
 * <module-headers:end>
 */
import { act } from '@testing-library/react';
import axe from 'axe-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from './App.tsx';
import { resetBuildInfoForTests } from './lib/buildInfo.ts';
import { Session } from './lib/native/machineView.ts';
import { orgStore } from './lib/orgStore.ts';
import { buildRoute } from './lib/route.ts';
import { renderShell } from './test/render.tsx';
import { ALL_ROUTES } from './test/routes.ts';

const TARGET = /(^|\s)(h-10|size-10|min-h-10|min-h-12|min-h-14|max-md:min-h-10)(\s|$)/;

function hasTarget(el: Element): boolean {
  for (let n: Element | null = el; n && n !== document.body; n = n.parentElement) {
    if (TARGET.test(n.getAttribute('class') ?? '')) return true;
  }
  // The kit's Switch documents its own 40 px hit area (packages/ui-kit/src/switch.tsx).
  return el.getAttribute('data-slot') === 'switch';
}

beforeEach(() => {
  resetBuildInfoForTests();
  orgStore.set({ loaded: true, orgs: [{ id: 'https://cp.example.com', name: 'Ada Org', teamDomain: null, addedAt: 'x' }] });
  vi.mocked(Session.request).mockResolvedValue({
    kind: 'ok',
    status: 200,
    body: { items: [{ id: '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b', name: 'laptop', hostname: 'laptop.example.com', url: 'https://laptop.example.com', status: 'online', status_checked_at: '2026-11-14T12:00:00Z', paired_at: '2026-11-14T12:00:00Z' }], next_cursor: null },
  });
  vi.mocked(Session.meta).mockResolvedValue({ service: 'yaran-cloud', protocol: { min: 1, max: 1 }, setup: 'closed', worker: { version: '1.0.0' }, org: { name: 'Ada Org', url: 'https://cp.example.com' } });
});

describe('accessibility', () => {
  for (const route of ALL_ROUTES) {
    it(`${buildRoute(route)} passes axe and meets the target floor`, async () => {
      window.location.hash = buildRoute(route);
      const { container } = renderShell(<App />);
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
      const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
      expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`)).toEqual([]);
      // A control hidden from assistive tech (base-ui's mirrored native input) is not a target.
      const controls = [...container.querySelectorAll('button, a[href], input, select, textarea, [role="switch"]')].filter((el) => el.getAttribute('aria-hidden') !== 'true');
      expect(controls.length).toBeGreaterThan(0);
      for (const el of controls) {
        expect(hasTarget(el), `no 40px target: ${el.outerHTML.slice(0, 160)}`).toBe(true);
      }
    });
  }
});
