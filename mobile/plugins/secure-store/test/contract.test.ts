/**
 * Contract tests for the secure-store TS definitions.
 *
 * Pins the reserved namespaces, the argument patterns and the error-code set the native
 * adapters must agree with, and proves the web fallback refuses with `unavailable`.
 *
 * - Type-level checks run under `tsc --noEmit`; runtime checks under Vitest.
 *
 * <module-headers:begin>
 * Uses:
 * test/contract.test.ts
 * ├── src/definitions.ts
 * └── src/web.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test in the plugin package)
 * <module-headers:end>
 */
import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  DEFAULT_LOCK_GRACE,
  KEY_RE,
  LOCK_GRACES,
  NAMESPACE_RE,
  RESERVED_NAMESPACES,
  SECURE_STORE_ERROR_CODES,
  type SecureStorePlugin,
} from '../src/definitions.ts';
import { unavailable } from '../src/web.ts';

describe('secure-store contract', () => {
  it('reserves exactly the native-only namespaces', () => {
    expect([...RESERVED_NAMESPACES]).toEqual(['session', 'handoff', 'install', 'push']);
  });

  it('has the stable error codes the native adapters map onto', () => {
    expect([...SECURE_STORE_ERROR_CODES]).toEqual([
      'invalid_argument',
      'reserved_namespace',
      'tampered',
      'invalidated',
      'locked',
      'unavailable',
    ]);
  });

  it('checks namespaces and keys the way the native validators do', () => {
    expect(NAMESPACE_RE.test('orgs')).toBe(true);
    expect(NAMESPACE_RE.test('Orgs')).toBe(false);
    expect(NAMESPACE_RE.test('a'.repeat(33))).toBe(false);
    expect(KEY_RE.test('list.v1')).toBe(true);
    expect(KEY_RE.test('a/b')).toBe(false);
  });

  it('defaults the lock grace to one minute', () => {
    expect(LOCK_GRACES).toContain(DEFAULT_LOCK_GRACE);
    expect(DEFAULT_LOCK_GRACE).toBe('1min');
  });

  it('get never returns undefined', () => {
    expectTypeOf<Awaited<ReturnType<SecureStorePlugin['get']>>>().toEqualTypeOf<{ value: string | null }>();
  });

  it('the web fallback rejects with unavailable', async () => {
    const plugin = unavailable as SecureStorePlugin;
    await expect(plugin.get({ namespace: 'orgs', key: 'list' })).rejects.toMatchObject({ code: 'unavailable' });
  });
});
