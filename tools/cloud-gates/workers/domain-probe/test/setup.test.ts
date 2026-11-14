/**
 * Setup form tests: input validation and the Cloudflare envelope summary for G14.
 *
 * Every field that ends up in an API URL or body is checked against a strict charset,
 * and the response summary keeps only envelope fields, truncated, never the token.
 *
 * - Pure: FormData and JSON only, no network.
 *
 * <module-headers:begin>
 * Uses:
 * test/setup.test.ts
 * └── src/setup.ts
 * External: vitest
 *
 * Used by:
 * test/setup.test.ts
 * └── entry point (vitest)
 * <module-headers:end>
 */
import { describe, expect, it } from 'vitest';
import { summarize, validateAttach, validateSubdomain } from '../src/setup';

const ACCOUNT = '0123456789abcdef0123456789abcdef';
const ZONE = 'fedcba9876543210fedcba9876543210';
const TOKEN = 'test-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

const attach = { token: TOKEN, account_id: ACCOUNT, zone_id: ZONE, hostname: 'Gate-CP.example.invalid', service: 'yaran-gate-domain-probe' };

describe('validateAttach', () => {
  it('accepts a complete form and lowercases the hostname', () => {
    const r = validateAttach(form(attach));
    expect(r).toEqual({
      ok: true,
      value: { token: TOKEN, accountId: ACCOUNT, zoneId: ZONE, hostname: 'gate-cp.example.invalid', service: 'yaran-gate-domain-probe' },
    });
  });

  it.each([
    ['token', 'short'],
    ['token', `${TOKEN} x`],
    ['account_id', 'not-hex'],
    ['account_id', `${ACCOUNT}0`],
    ['zone_id', '../../accounts'],
    ['hostname', 'no_underscore.example.invalid'],
    ['hostname', 'single-label'],
    ['hostname', 'a.example.invalid/path'],
    ['service', 'Upper'],
    ['service', 'a/b'],
  ])('refuses a bad %s (%s)', (name, value) => {
    const r = validateAttach(form({ ...attach, [name]: value }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).not.toContain(TOKEN);
  });
});

describe('validateSubdomain', () => {
  const sub = { token: TOKEN, account_id: ACCOUNT, script: 'yaran-gate-domain-probe', enabled: 'false', previews_enabled: 'false' };

  it('parses the booleans', () => {
    expect(validateSubdomain(form({ ...sub, enabled: 'true' }))).toMatchObject({ ok: true, value: { enabled: true, previewsEnabled: false } });
  });

  it.each([
    ['enabled', 'yes'],
    ['previews_enabled', ''],
    ['script', '../x'],
  ])('refuses a bad %s', (name, value) => {
    expect(validateSubdomain(form({ ...sub, [name]: value })).ok).toBe(false);
  });
});

describe('summarize', () => {
  it('keeps envelope fields and truncates messages', () => {
    const long = 'x'.repeat(500);
    const s = summarize(403, JSON.stringify({ success: false, errors: [{ code: 10000, message: long }], messages: [long], result: null }));
    expect(s.httpStatus).toBe(403);
    expect(s.success).toBe(false);
    expect(s.errors[0]).toEqual({ code: 10000, message: 'x'.repeat(300) });
    expect(s.messages[0]).toBe('x'.repeat(300));
  });

  it('passes the result through on success', () => {
    const s = summarize(200, JSON.stringify({ success: true, errors: [], messages: [], result: { id: 'abc', hostname: 'h' } }));
    expect(s).toEqual({ httpStatus: 200, success: true, errors: [], messages: [], result: { id: 'abc', hostname: 'h' } });
  });

  it('reports a non-JSON answer instead of throwing', () => {
    const s = summarize(502, '<html>bad gateway</html>');
    expect(s.success).toBe(false);
    expect(s.errors[0]?.message).toContain('non-JSON response');
  });
});
