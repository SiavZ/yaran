/**
 * Tests for typed org URL normalisation and its refusal sentences.
 *
 * <module-headers:begin>
 * Uses:
 * src/lib/orgUrl.test.ts
 * └── src/lib/orgUrl.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test in mobile/app)
 * <module-headers:end>
 */
import { describe, expect, it } from 'vitest';

import { normalizeTypedOrgUrl, refusalMessage } from './orgUrl.ts';

describe('normalizeTypedOrgUrl', () => {
  it('adds https to a bare host', () => {
    expect(normalizeTypedOrgUrl(' cp.example.com ')).toEqual({ ok: true, value: 'https://cp.example.com' });
  });
  it('keeps an explicit https and drops :443', () => {
    expect(normalizeTypedOrgUrl('https://CP.example.com:443/')).toEqual({ ok: true, value: 'https://cp.example.com' });
  });
  it('treats host:port as a host, then refuses the port', () => {
    expect(normalizeTypedOrgUrl('cp.example.com:8443')).toEqual({ ok: false, refused: 'port' });
  });
  it('refuses http instead of upgrading it', () => {
    expect(normalizeTypedOrgUrl('http://cp.example.com')).toEqual({ ok: false, refused: 'not_https' });
  });
  it('refuses other schemes', () => {
    expect(normalizeTypedOrgUrl('javascript:alert(1)')).toEqual({ ok: false, refused: 'not_https' });
  });
  it('reports empty input', () => {
    expect(normalizeTypedOrgUrl('   ')).toEqual({ ok: false, refused: 'empty' });
  });
  it('has a sentence for every refusal', () => {
    for (const r of ['empty', 'not_https', 'userinfo', 'ip_literal', 'idn', 'port', 'path', 'query', 'fragment', 'invalid'] as const) {
      expect(refusalMessage(r).message ?? refusalMessage(r).id).toBeTruthy();
    }
  });
});
