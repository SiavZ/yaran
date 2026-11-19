/**
 * Tests for lifecycle wiring: resume refresh and reopening the last machine.
 *
 * <module-headers:begin>
 * Uses:
 * src/lib/lifecycle.test.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/lib/directStore.ts
 * ├── src/lib/lifecycle.ts
 * ├── src/lib/machinesStore.ts
 * ├── src/lib/native/machineView.ts
 * ├── src/lib/orgStore.ts
 * ├── src/lib/route.ts
 * ├── src/lib/settingsStore.ts
 * └── src/lib/share.ts
 * External: @capacitor/app, vitest
 *
 * Used by: entry point (vitest, via npm test in mobile/app)
 * <module-headers:end>
 */
import { App } from '@capacitor/app';
import { describe, expect, it, vi } from 'vitest';
import type { MachineSummary } from '@yaran/protocol';

import { addDirect } from './directStore.ts';
import { installLifecycle, reopenLastMachine, startUnlocked } from './lifecycle.ts';
import { parseRoute } from './route.ts';
import { shareStore } from './share.ts';
import { machinesStore } from './machinesStore.ts';
import { MachineView, Session } from './native/machineView.ts';
import { orgStore } from './orgStore.ts';
import { DEFAULT_SETTINGS, settingsStore } from './settingsStore.ts';

const last = { orgId: 'https://cp.example.com', machineId: 'm', host: 'm1.example.com' };
const org = { id: last.orgId, name: 'Ada', teamDomain: null, addedAt: 'x' };

describe('reopenLastMachine', () => {
  it('reopens when the setting is on and the org is still added', async () => {
    orgStore.set({ loaded: true, orgs: [org] });
    settingsStore.set({ ...DEFAULT_SETTINGS, reopenLastMachine: true, lastMachine: { ...last, host: 'stale.example.com' } });
    machinesStore.set({ [last.orgId]: { state: 'ready', machines: [{ id: 'm', hostname: 'm1.example.com' } as MachineSummary], fetchedAt: 0 } });
    expect(await reopenLastMachine()).toBe(true);
    // The host comes from the authenticated list, not from the saved setting.
    expect(MachineView.open).toHaveBeenCalledWith(last);
  });
  it('refreshes a cold list first and refuses a machine it no longer lists', async () => {
    orgStore.set({ loaded: true, orgs: [org] });
    settingsStore.set({ ...DEFAULT_SETTINGS, reopenLastMachine: true, lastMachine: last });
    machinesStore.set({});
    expect(await reopenLastMachine()).toBe(false);
    expect(Session.request).toHaveBeenCalled();
    expect(MachineView.open).not.toHaveBeenCalled();
  });
  it('does nothing when the setting is off or the org is gone', async () => {
    settingsStore.set({ ...DEFAULT_SETTINGS, reopenLastMachine: false, lastMachine: last });
    expect(await reopenLastMachine()).toBe(false);
    orgStore.set({ loaded: true, orgs: [] });
    settingsStore.set({ ...DEFAULT_SETTINGS, reopenLastMachine: true, lastMachine: last });
    expect(await reopenLastMachine()).toBe(false);
    expect(MachineView.open).not.toHaveBeenCalled();
  });
});

describe('installLifecycle', () => {
  it('refreshes every org on resume', async () => {
    orgStore.set({ loaded: true, orgs: [org] });
    await installLifecycle(() => {});
    const calls = vi.mocked(App.addListener).mock.calls as unknown as [string, () => void][];
    const resume = calls.find((c) => c[0] === 'resume')![1];
    resume();
    expect(Session.request).toHaveBeenCalledWith(expect.objectContaining({ orgId: org.id, path: '/v1/me/machines' }));
  });
});

describe('direct machines and shares at launch', () => {
  it('reopens the last direct machine from its stored record', async () => {
    const r = await addDirect({ host: 'box.tail1.ts.net', instance: 'inst-1' });
    settingsStore.set({ ...DEFAULT_SETTINGS, reopenLastMachine: true, lastMachine: { directId: r.id } });
    expect(await reopenLastMachine()).toBe(true);
    expect(MachineView.open).toHaveBeenCalledWith({ kind: 'direct', host: 'box.tail1.ts.net', instance: 'inst-1' });
  });
  it('does nothing for a direct machine that was removed', async () => {
    settingsStore.set({ ...DEFAULT_SETTINGS, reopenLastMachine: true, lastMachine: { directId: 'gone' } });
    expect(await reopenLastMachine()).toBe(false);
    expect(MachineView.open).not.toHaveBeenCalled();
  });
  it('a waiting share shows the share screen instead of reopening a machine over it', async () => {
    const r = await addDirect({ host: 'box.tail1.ts.net', instance: null });
    settingsStore.set({ ...DEFAULT_SETTINGS, reopenLastMachine: true, lastMachine: { directId: r.id } });
    vi.mocked(MachineView.shareStatus).mockResolvedValueOnce({ kind: 'pending', count: 2, batch: 'share-2' });
    await startUnlocked();
    expect(parseRoute(window.location.hash)).toEqual({ name: 'share' });
    expect(MachineView.open).not.toHaveBeenCalled();
  });
  it('a share event routes to the share screen and an older native that cannot pull still counts', async () => {
    await installLifecycle(() => {});
    const calls = vi.mocked(MachineView.addListener).mock.calls as unknown as [string, (e: unknown) => void][];
    const received = calls.find((c) => c[0] === 'shareReceived')![1];
    vi.mocked(MachineView.shareStatus).mockRejectedValueOnce(new Error('not implemented'));
    received({ kind: 'files', count: 3, dropped: 0, batch: 'share-3' });
    await vi.waitFor(() => expect(parseRoute(window.location.hash)).toEqual({ name: 'share' }));
    expect(shareStore.get()).toEqual({ kind: 'pending', count: 3, batch: 'share-3' });
  });
});
