/**
 * Tests for openMachine: host resolution from the machines list, route refusal, closed routing.
 *
 * <module-headers:begin>
 * Uses:
 * src/lib/openMachine.test.ts
 * ├── @yaran/machine-view:src/index.ts
 * ├── src/lib/directStore.ts
 * └── src/lib/openMachine.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test in mobile/app)
 * <module-headers:end>
 */
import type { OpenOptions } from '@yaran/machine-view';
import { describe, expect, it } from 'vitest';

import type { DirectRecord } from './directStore.ts';
import { closedDestination, openAgent, openDirect, openMachine, type OpenMachineDeps } from './openMachine.ts';

const ORG = 'https://cp.example.com';
const MACHINE = '0b5f9a8e-6d0e-4f43-9a51-1d6f7d9b1c2a';

const DIRECT: DirectRecord = {
  id: 'd1',
  label: 'box.tail1.ts.net',
  host: 'box.tail1.ts.net',
  instance: 'inst-1',
  addedAt: 'x',
  routes: [{ kind: 'direct', host: 'box.tail1.ts.net' }],
};

function deps(direct: DirectRecord = DIRECT): OpenMachineDeps & { opened: OpenOptions[] } {
  const opened: OpenOptions[] = [];
  return {
    opened,
    machines: (orgId) => (orgId === ORG ? [{ id: MACHINE, hostname: 'laptop-ada.example.com' }] : undefined),
    orgKnown: (orgId) => orgId === ORG,
    orgHost: (host) => host === 'laptop-ada.example.com' || host === 'cp.example.com',
    direct: (id) => (id === direct.id ? direct : undefined),
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

  it('turns a native refusal into a result with its code, never a silent rejection', async () => {
    const d = deps();
    d.machineView = { open: () => Promise.reject(Object.assign(new Error('bad'), { code: 'invalid_arguments' })) };
    expect(await openMachine(ORG, MACHINE, undefined, d)).toEqual({ ok: false, reason: 'native_refused', code: 'invalid_arguments' });
    d.machineView = { open: () => Promise.reject(new Error('no code; <b>untrusted</b>')) };
    expect(await openMachine(ORG, MACHINE, undefined, d)).toEqual({ ok: false, reason: 'native_refused', code: 'unknown' });
  });

  it('refuses a route outside the agent grammar', async () => {
    const d = deps();
    expect(await openMachine(ORG, MACHINE, { route: '#/terminal/t1' }, d)).toEqual({ ok: false, reason: 'bad_route' });
    expect(await openMachine(ORG, MACHINE, { route: 'javascript:alert(1)' }, d)).toEqual({ ok: false, reason: 'bad_route' });
    expect(d.opened).toEqual([]);
  });

  it('openAgent builds and passes the encoded route', async () => {
    const d = deps();
    expect(await openAgent(ORG, MACHINE, 'sess 1', 'tab/2', d)).toEqual({ ok: true });
    expect(d.opened[0]?.route).toBe('#/agent/sess%201/tab/tab%2F2');
    expect(await openAgent(ORG, MACHINE, '', undefined, d)).toEqual({ ok: false, reason: 'bad_route' });
  });
});

describe('openDirect', () => {
  it('opens a one-route machine as direct with its recorded instance, and the named share batch when asked', async () => {
    const d = deps();
    expect(await openDirect('d1', { shareBatch: 'batch-a' }, d)).toEqual({ ok: true });
    expect(d.opened).toEqual([{ kind: 'direct', host: 'box.tail1.ts.net', instance: 'inst-1', shareBatch: 'batch-a' }]);
  });

  it('opens several routes in the user order, re-resolving org hosts from the live list', async () => {
    const d = deps({
      ...DIRECT,
      routes: [
        { kind: 'org', orgId: ORG, machineId: MACHINE, host: 'stale.example.com' },
        { kind: 'direct', host: 'box.tail1.ts.net' },
      ],
    });
    await openDirect('d1', { route: '#/agent/a%2Fb/tab/t' }, d);
    expect(d.opened).toEqual([
      {
        kind: 'routes',
        instance: 'inst-1',
        route: '#/agent/a%2Fb/tab/t',
        routes: [
          { kind: 'org', orgId: ORG, machineId: MACHINE, host: 'laptop-ada.example.com' },
          { kind: 'direct', host: 'box.tail1.ts.net' },
        ],
      },
    ]);
  });

  it('drops routes through a gone org or an unlisted machine', async () => {
    const d = deps({
      ...DIRECT,
      routes: [
        { kind: 'org', orgId: 'https://left.example.com', machineId: MACHINE, host: 'x.example.com' },
        { kind: 'org', orgId: ORG, machineId: 'removed', host: 'y.example.com' },
        { kind: 'direct', host: 'box.tail1.ts.net' },
      ],
    });
    await openDirect('d1', {}, d);
    expect(d.opened).toEqual([{ kind: 'direct', host: 'box.tail1.ts.net', instance: 'inst-1' }]);
  });

  it('never opens a direct host that an org now claims', async () => {
    const d = deps({ ...DIRECT, host: 'cp.example.com', routes: [{ kind: 'direct', host: 'cp.example.com' }] });
    expect(await openDirect('d1', {}, d)).toEqual({ ok: false, reason: 'host_conflict' });
    expect(d.opened).toEqual([]);
  });

  it('refuses an unknown record and a bad route', async () => {
    const d = deps();
    expect(await openDirect('nope', {}, d)).toEqual({ ok: false, reason: 'unknown_machine' });
    expect(await openDirect('d1', { route: '#/editor' }, d)).toEqual({ ok: false, reason: 'bad_route' });
    expect(d.opened).toEqual([]);
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
