/**
 * Tests for incoming link routing, including the add-org confirm rule (T42).
 *
 * <module-headers:begin>
 * Uses:
 * src/lib/deepLinks.test.ts
 * ├── src/lib/deepLinks.ts
 * └── src/lib/route.ts
 * External: sonner, vitest
 *
 * Used by: entry point (vitest, via npm test in mobile/app)
 * <module-headers:end>
 */
import { toast } from 'sonner';
import { describe, expect, it, vi } from 'vitest';

import { handleAppUrl, routeForAppUrl } from './deepLinks.ts';
import { parseRoute } from './route.ts';

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn(), loading: vi.fn() } }));

describe('routeForAppUrl', () => {
  it('sends add-org to Confirm org, never straight in', () => {
    expect(routeForAppUrl('yaranapp://add-org?u=https%3A%2F%2Fcp.example.com')).toEqual({ name: 'confirm', url: 'https://cp.example.com' });
  });
  it('refuses an add-org URL the host rules reject', () => {
    expect(routeForAppUrl('yaranapp://add-org?u=https%3A%2F%2Fxn--80ak6aa92e.com')).toBe('refused');
  });
  it('refuses malformed and foreign links', () => {
    expect(routeForAppUrl('yaranapp://add-org?u=http%3A%2F%2Fcp.example.com')).toBe('refused');
    expect(routeForAppUrl('https://cp.example.com')).toBe('refused');
    expect(routeForAppUrl('yaranapp://nope')).toBe('refused');
  });
  it('maps home and settings, ignores reauth', () => {
    expect(routeForAppUrl('yaranapp://home')).toEqual({ name: 'machines' });
    expect(routeForAppUrl('yaranapp://settings')).toEqual({ name: 'settings' });
    expect(routeForAppUrl('yaranapp://reauth?host=m1.example.com')).toBeNull();
  });
});

describe('handleAppUrl', () => {
  it('navigates to the confirm screen', () => {
    handleAppUrl('yaranapp://add-org?u=https%3A%2F%2Fcp.example.com');
    expect(parseRoute(window.location.hash)).toEqual({ name: 'confirm', url: 'https://cp.example.com' });
  });
  it('warns on a refused link', () => {
    handleAppUrl('yaranapp://nope');
    expect(toast.warning).toHaveBeenCalled();
  });
});
