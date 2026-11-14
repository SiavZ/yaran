/**
 * Handoff tests: redirect allowlist, field validation, the 303 location and the consent page's CSP.
 *
 * Pins the rules 06 and 11 will ship for the real /v1/handoff: only the exact callback
 * for the build may be a redirect target, Continue carries state and jwe, Cancel carries
 * error=handoff_declined, and form-action admits the callback origin.
 *
 * - Pure; no Worker runtime.
 *
 * <module-headers:begin>
 * Uses:
 * test/handoff.test.ts
 * └── src/handoff.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test in the Worker directory)
 * <module-headers:end>
 */
import { describe, expect, it } from 'vitest';
import { consentCsp, consentPage, decisionLocation, DUMMY_JWE, parseDecision, validateHandoff, type HandoffConfig } from '../src/handoff';

const cfg: HandoffConfig = { callbackHost: 'gate-callback.example.invalid', devScheme: 'yaranapp-gate' };
const STATE = 'abcdefghij_KLMNOP-0123';
const RELEASE = 'https://gate-callback.example.invalid/auth/callback';

const q = (fields: Record<string, string>) => new URLSearchParams(fields);

describe('validateHandoff', () => {
  it('accepts a release request and defaults build to release', () => {
    expect(validateHandoff(q({ state: STATE, redirect: RELEASE, device: 'Pixel 9' }), cfg, true)).toEqual({
      ok: true,
      value: { state: STATE, redirect: RELEASE, build: 'release', device: 'Pixel 9' },
    });
    const oauth = 'https://gate-callback.example.invalid/oauth/callback';
    expect(validateHandoff(q({ state: STATE, redirect: oauth, device: 'x' }), cfg, true).ok).toBe(true);
  });

  it('accepts the dev scheme only for build=dev', () => {
    const dev = 'yaranapp-gate://auth/callback';
    expect(validateHandoff(q({ state: STATE, redirect: dev, build: 'dev', device: 'x' }), cfg, true).ok).toBe(true);
    expect(validateHandoff(q({ state: STATE, redirect: dev, device: 'x' }), cfg, true).ok).toBe(false);
    expect(validateHandoff(q({ state: STATE, redirect: RELEASE, build: 'dev', device: 'x' }), cfg, true).ok).toBe(false);
  });

  it.each([
    ['redirect', 'https://evil.example.invalid/auth/callback'],
    ['redirect', `${RELEASE}?x=1`],
    ['redirect', 'http://gate-callback.example.invalid/auth/callback'],
    ['redirect', 'yaranapp://auth/callback'],
    ['state', 'short'],
    ['state', `${STATE}!`],
    ['state', 'a'.repeat(129)],
    ['build', 'debug'],
    ['device', ''],
    ['device', 'd'.repeat(65)],
    ['device', 'evil‮elif'],
    ['device', 'line\nbreak'],
  ])('refuses a bad %s', (name, value) => {
    const fields = { state: STATE, redirect: RELEASE, device: 'Pixel', [name]: value };
    expect(validateHandoff(q(fields), cfg, true).ok).toBe(false);
  });

  it('does not require a device for the form POST', () => {
    expect(validateHandoff(q({ state: STATE, redirect: RELEASE }), cfg, false).ok).toBe(true);
  });
});

describe('decision', () => {
  const h = { state: STATE, redirect: RELEASE, build: 'release' as const, device: null };

  it('continue answers with state and the dummy jwe', () => {
    expect(decisionLocation(h, 'continue')).toBe(`${RELEASE}?state=${STATE}&jwe=${DUMMY_JWE}`);
    expect(DUMMY_JWE.split('.')).toHaveLength(5);
  });

  it('cancel answers with error=handoff_declined', () => {
    expect(decisionLocation(h, 'cancel')).toBe(`${RELEASE}?state=${STATE}&error=handoff_declined`);
  });

  it('parses only the two decisions', () => {
    expect(parseDecision('continue')).toBe('continue');
    expect(parseDecision('cancel')).toBe('cancel');
    expect(parseDecision('Continue')).toBeNull();
    expect(parseDecision(null)).toBeNull();
  });
});

describe('consent page', () => {
  it('CSP form-action admits the callback origin for release and the scheme for dev', () => {
    expect(consentCsp('release', cfg)).toContain("form-action 'self' https://gate-callback.example.invalid;");
    expect(consentCsp('dev', cfg)).toContain("form-action 'self' yaranapp-gate:;");
    expect(consentCsp('release', cfg)).toContain("frame-ancestors 'none'");
    expect(consentCsp('release', cfg)).toMatch(/^default-src 'none';/);
  });

  it('escapes the device and host, and warns only for dev builds', () => {
    const page = consentPage({ state: STATE, redirect: RELEASE, build: 'release', device: '<b>x</b>' }, 'cp.example.invalid');
    expect(page).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(page).toContain('cp.example.invalid');
    expect(page).not.toContain('Development build');
    expect(page).toContain('name="decision" value="continue"');
    const dev = consentPage({ state: STATE, redirect: 'yaranapp-gate://auth/callback', build: 'dev', device: 'x' }, 'h');
    expect(dev).toContain('Development build');
  });
});
