/**
 * Tests for the push wiring: sign-out unregisters the device row first, and a notification
 * tap opens only a machine from the authenticated list.
 *
 * <module-headers:begin>
 * Uses:
 * src/push/pushWiring.test.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── @yaran/push:src/index.ts
 * ├── src/lib/machinesStore.ts
 * ├── src/lib/native/machineView.ts
 * ├── src/lib/orgStore.ts
 * ├── src/push/pushDeps.ts
 * ├── src/push/pushTestKit.ts
 * └── src/push/pushWiring.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test in mobile/app)
 * <module-headers:end>
 */
import type { MachineSummary } from '@yaran/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { machinesStore } from '../lib/machinesStore.ts';
import { MachineView, Session } from '../lib/native/machineView.ts';
import { orgStore, signOutOrg } from '../lib/orgStore.ts';
import { pushStore } from './pushDeps.ts';
import { installPush } from './pushWiring.ts';
import { device, MACHINE } from './pushTestKit.ts';

const listeners = new Map<string, (e: unknown) => void>();
vi.mock('@yaran/push', async (orig) => ({
  ...(await orig<typeof import('@yaran/push')>()),
  Push: {
    addListener: vi.fn(async (name: string, fn: (e: unknown) => void) => (listeners.set(name, fn), { remove: async () => {} })),
    drainPendingRegistrations: vi.fn(async () => ({ orgIds: [] })),
    forgetOrg: vi.fn(async () => {}),
    clearDelivered: vi.fn(async () => {}),
  },
}));

const ORG = { id: 'https://cp.example.com', name: 'Ada', teamDomain: null, addedAt: 'x' };

afterEach(() => {
  pushStore.set({});
  machinesStore.set({});
  orgStore.set({ loaded: true, orgs: [] });
});

describe('push wiring', () => {
  it('sends W14 for the device row before signing out of the org', async () => {
    orgStore.set({ loaded: true, orgs: [ORG] });
    pushStore.set({ [ORG.id]: { kind: 'row', state: { kind: 'active' }, device: device() } });
    const order: string[] = [];
    vi.mocked(Session.request).mockImplementation(async (o) => (order.push(`${o.method} ${o.path}`), { kind: 'ok', status: 204, body: null }));
    vi.mocked(Session.signOut).mockImplementation(async () => void order.push('signOut'));
    await signOutOrg(ORG.id);
    expect(order).toEqual([`DELETE /v1/me/devices/${device().id}`, 'signOut']);
    expect(pushStore.get()).toEqual({});
  });

  it('opens a tapped machine from the authenticated list and nothing else', async () => {
    orgStore.set({ loaded: true, orgs: [ORG] });
    machinesStore.set({ [ORG.id]: { state: 'ready', machines: [{ id: MACHINE, name: 'box', hostname: 'box.example.com' } as MachineSummary], fetchedAt: 0 } });
    await installPush();
    const tap = listeners.get('notificationTapped')!;
    tap({ orgId: ORG.id, machineId: MACHINE, agentId: 'a1', action: 'open' });
    await vi.waitFor(() => expect(MachineView.open).toHaveBeenCalledWith({ orgId: ORG.id, machineId: MACHINE, host: 'box.example.com', route: '#/agent/a1' }));
    vi.mocked(MachineView.open).mockClear();
    tap({ orgId: ORG.id, machineId: '11111111-1111-4111-8111-111111111111', agentId: 'a1', action: 'open' });
    await new Promise((r) => setTimeout(r, 10));
    expect(MachineView.open).not.toHaveBeenCalled();
  });
});
