/**
 * Tests for the protocol verdict in both mismatch directions.
 *
 * <module-headers:begin>
 * Uses:
 * src/lib/protocolCompat.test.ts
 * └── src/lib/protocolCompat.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test in mobile/app)
 * <module-headers:end>
 */
import { describe, expect, it } from 'vitest';

import { protocolVerdict, updateFor } from './protocolCompat.ts';

const app = { min: 1, max: 2 };

describe('protocolVerdict', () => {
  it('agrees on the highest common version', () => {
    expect(protocolVerdict({ protocol: { min: 1, max: 3 } }, app)).toEqual({ ok: true, version: 2, deprecatedAfter: null });
  });
  it('says the app must update when the control plane is newer', () => {
    expect(protocolVerdict({ protocol: { min: 3, max: 4 } }, app)).toEqual({ ok: false, update: 'app' });
  });
  it('says the control plane must update when it is older', () => {
    expect(protocolVerdict({ protocol: { min: 1, max: 1 } }, { min: 2, max: 3 })).toEqual({ ok: false, update: 'control_plane' });
  });
  it('carries a deprecation date for the chosen version', () => {
    expect(protocolVerdict({ protocol: { min: 1, max: 2 }, deprecations: [{ protocol: 2, after: '2027-06-01' }] }, app)).toEqual({
      ok: true,
      version: 2,
      deprecatedAfter: '2027-06-01',
    });
  });
});

describe('updateFor', () => {
  it('reads the server range a native protocol_unsupported carries', () => {
    expect(updateFor({ min: 3, max: 4 }, { min: 1, max: 2 })).toBe('client');
    expect(updateFor({ min: 1, max: 1 }, { min: 2, max: 3 })).toBe('server');
  });
  it('asks for an app update when the server sent no range', () => {
    expect(updateFor({})).toBe('client');
  });
});
