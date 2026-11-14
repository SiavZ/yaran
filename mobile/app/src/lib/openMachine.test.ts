/**
 * Tests for openMachine: host resolution from the machines list, route refusal, closed routing.
 *
 * <module-headers:begin>
 * Uses:
 * src/lib/openMachine.test.ts
 * ├── @yaran/machine-view:src/index.ts
 * └── src/lib/openMachine.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test in mobile/app)
 * <module-headers:end>
 */
import type { OpenOptions } from '@yaran/machine-view';
import { describe, expect, it } from 'vitest';

import { closedDestination, openAgent, openMachine, type OpenMachineDeps } from './openMachine.ts';

const ORG = 'https://cp.example.com';
const MACHINE = '0b5f9a8e-6d0e-4f43-9a51-1d6f7d9b1c2a';

function deps(): OpenMachineDeps & { opened: OpenOptions[] } {
  const opened: OpenOptions[] = [];
  return {
    opened,
    machines: (orgId) => (orgId === ORG ? [{ id: MACHINE, hostname: 'laptop-ada.example.com' }] : undefined),
    machineView: { open: async (o) => void opened.push(o) },
  };
}

describe('openMachine', () => {
  it('opens the host from the machines list, never a caller-supplied one', async () => {
    const d = deps();
    expect(await openMachine(ORG, MACHINE, undefined, d)).toEqual({ ok: true });
    expect(d.opened).toEqual([{ orgId: ORG, machineId: MACHINE, host: 'laptop-ada.example.com' }]);
  });

  it('refuses an unknown machine, an unknown org and a never-loaded list', async () => {
    const d = deps();
    expect(await openMachine(ORG, 'other', undefined, d)).toEqual({ ok: false, reason: 'unknown_machine' });
    expect(await openMachine('https://other.example.com', MACHINE, undefined, d)).toEqual({ ok: false, reason: 'unknown_machine' });
    expect(d.opened).toEqual([]);
  });

  it('refuses a route outside the agent grammar', async () => {
    const d = deps();
    expect(await openMachine(ORG, MACHINE, '#/terminal/t1', d)).toEqual({ ok: false, reason: 'bad_route' });
    expect(await openMachine(ORG, MACHINE, 'javascript:alert(1)', d)).toEqual({ ok: false, reason: 'bad_route' });
    expect(d.opened).toEqual([]);
  });

  it('openAgent builds and passes the encoded route', async () => {
    const d = deps();
    expect(await openAgent(ORG, MACHINE, 'sess 1', 'tab/2', d)).toEqual({ ok: true });
    expect(d.opened[0]?.route).toBe('#/agent/sess%201/tab/tab%2F2');
    expect(await openAgent(ORG, MACHINE, '', undefined, d)).toEqual({ ok: false, reason: 'bad_route' });
  });
});

describe('closedDestination', () => {
  it('routes every reason', () => {
    expect(closedDestination({ reason: 'user' })).toBe('machines');
    expect(closedDestination({ reason: 'home' })).toBe('machines');
    expect(closedDestination({ reason: 'error', code: 'renderer_gone' })).toBe('machines');
    expect(closedDestination({ reason: 'settings' })).toBe('settings');
    expect(closedDestination({ reason: 'signedOut' })).toBe('org_sign_in');
  });
});
