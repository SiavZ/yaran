/**
 * Host lock tests: the full open/closed by host by path table G14 step 8 probes.
 *
 * Pins the rule Phase 04/07 will ship: workers.dev serves only setup and meta while setup
 * is open; once closed, every non-custom Host gets 421 with a body naming no host, and the
 * custom host refuses /setup* with 410.
 *
 * - Pure table test; no Worker runtime needed.
 *
 * <module-headers:begin>
 * Uses:
 * test/host-lock.test.ts
 * └── src/host-lock.ts
 * External: vitest
 *
 * Used by:
 * test/host-lock.test.ts
 * └── entry point (vitest)
 * <module-headers:end>
 */
import { describe, expect, it } from 'vitest';
import { hostLock, parseSetupState, type SetupState } from '../src/host-lock';

const CP = 'gate-cp.example.invalid';
const DEV = 'yaran-gate-domain-probe.someone.workers.dev';
const OTHER = 'attacker.example.invalid';

type Row = [SetupState, string, string, number | 'allow'];

const TABLE: Row[] = [
  ['open', DEV, '/setup', 'allow'],
  ['open', DEV, '/setup/attach', 'allow'],
  ['open', DEV, '/v1/meta', 'allow'],
  ['open', DEV, '/', 404],
  ['open', DEV, '/setupx', 404],
  ['open', DEV, '/v1/meta/x', 404],
  ['open', DEV, '/v1/me', 404],
  ['open', CP, '/setup', 'allow'],
  ['open', CP, '/v1/meta', 'allow'],
  ['open', CP, '/v1/me', 'allow'],
  ['open', OTHER, '/v1/meta', 'allow'],
  ['open', OTHER, '/v1/me', 404],
  ['closed', DEV, '/setup', 421],
  ['closed', DEV, '/v1/meta', 421],
  ['closed', DEV, '/', 421],
  ['closed', OTHER, '/v1/meta', 421],
  ['closed', CP, '/setup', 410],
  ['closed', CP, '/setup/attach', 410],
  ['closed', CP, '/v1/meta', 'allow'],
  ['closed', CP, '/v1/me', 'allow'],
  ['closed', `${CP.toUpperCase()}:443`, '/v1/meta', 'allow'],
];

describe('hostLock', () => {
  it.each(TABLE)('%s %s %s -> %s', (state, host, path, expected) => {
    const verdict = hostLock(host, path, state, CP);
    if (expected === 'allow') expect(verdict.allow).toBe(true);
    else expect(verdict).toMatchObject({ allow: false, status: expected });
  });

  it('codes match the cloud protocol names', () => {
    expect(hostLock(DEV, '/x', 'open', CP)).toMatchObject({ code: 'not_found' });
    expect(hostLock(DEV, '/x', 'closed', CP)).toMatchObject({ code: 'misdirected_host' });
    expect(hostLock(CP, '/setup', 'closed', CP)).toMatchObject({ code: 'setup_closed' });
  });

  it('the 421 message names neither the custom host nor the request host', () => {
    for (const host of [DEV, OTHER]) {
      const verdict = hostLock(host, '/v1/meta', 'closed', CP);
      if (verdict.allow) throw new Error('expected a refusal');
      expect(verdict.message).not.toContain(CP);
      expect(verdict.message).not.toContain(host);
      expect(verdict.message).not.toMatch(/workers\.dev|example\.invalid/);
    }
  });

  it('SETUP_STATE fails closed on anything but "open"', () => {
    expect(parseSetupState('open')).toBe('open');
    expect(parseSetupState('closed')).toBe('closed');
    expect(parseSetupState('Open')).toBe('closed');
    expect(parseSetupState(undefined)).toBe('closed');
  });
});
