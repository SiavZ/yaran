/**
 * Tests for the add-org QR payload parser against Phase 02's shared URI fixture.
 *
 * Every `parse` case of `cloud/protocol/fixtures/uri/add-org.json` must agree, plus the
 * scanner-specific refusals: a non-yaran QR, another yaranapp command, `http`, extra
 * parameters (ignored) and a missing `u`.
 *
 * - Pure; no camera, no wasm.
 *
 * <module-headers:begin>
 * Uses:
 * test/payload.test.ts
 * ├── cloud/protocol/fixtures/uri/add-org.json
 * └── src/payload.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test in the plugin package)
 * <module-headers:end>
 */
import fixture from '@yaran/protocol/fixtures/uri/add-org.json' with { type: 'json' };
import { describe, expect, it } from 'vitest';

import { parseAddOrgPayload } from '../src/payload.ts';

describe('parseAddOrgPayload', () => {
  for (const c of fixture.parse) {
    it(`fixture: ${c.uri.slice(0, 60)}`, () => {
      const got = parseAddOrgPayload(c.uri);
      if (typeof c.expect === 'object' && c.expect !== null && 'org_url' in c.expect) {
        expect(got).toEqual({ ok: true, orgUrl: c.expect.org_url });
      } else {
        expect(got.ok).toBe(false);
      }
    });
  }

  it('accepts the canonical payload', () => {
    expect(parseAddOrgPayload('yaranapp://add-org?u=https%3A%2F%2Fcp.example.com')).toEqual({ ok: true, orgUrl: 'https://cp.example.com' });
  });
  it('refuses an http org URL', () => {
    expect(parseAddOrgPayload('yaranapp://add-org?u=http%3A%2F%2Fcp.example.com').ok).toBe(false);
  });
  it('ignores extra parameters', () => {
    expect(parseAddOrgPayload('yaranapp://add-org?u=https%3A%2F%2Fcp.example.com&x=1')).toEqual({ ok: true, orgUrl: 'https://cp.example.com' });
  });
  it('refuses a missing u', () => {
    expect(parseAddOrgPayload('yaranapp://add-org')).toEqual({ ok: false, reason: 'invalid' });
  });
  it('names a QR that is not a yaran link', () => {
    expect(parseAddOrgPayload('https://cp.example.com')).toEqual({ ok: false, reason: 'not_yaran' });
  });
  it('refuses another yaranapp command', () => {
    expect(parseAddOrgPayload('yaranapp://home')).toEqual({ ok: false, reason: 'not_add_org' });
  });
});
