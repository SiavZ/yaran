/**
 * Tests for lifecycle wiring: resume refresh and reopening the last machine.
 *
 * <module-headers:begin>
 * Uses:
 * src/lib/lifecycle.test.ts
 * ├── src/lib/lifecycle.ts
 * ├── src/lib/native/machineView.ts
 * ├── src/lib/orgStore.ts
 * └── src/lib/settingsStore.ts
 * External: @capacitor/app, vitest
 *
 * Used by: entry point (vitest, via npm test in mobile/app)
 * <module-headers:end>
 */
import { App } from '@capacitor/app';
import { describe, expect, it, vi } from 'vitest';

import { installLifecycle, reopenLastMachine } from './lifecycle.ts';
import { MachineView, Session } from './native/machineView.ts';
import { orgStore } from './orgStore.ts';
import { DEFAULT_SETTINGS, settingsStore } from './settingsStore.ts';

const last = { orgId: 'https://cp.example.com', machineId: 'm', host: 'm1.example.com' };
const org = { id: last.orgId, name: 'Ada', teamDomain: null, addedAt: 'x' };

describe('reopenLastMachine', () => {
  it('reopens when the setting is on and the org is still added', async () => {
    orgStore.set({ loaded: true, orgs: [org] });
    settingsStore.set({ ...DEFAULT_SETTINGS, reopenLastMachine: true, lastMachine: last });
    expect(await reopenLastMachine()).toBe(true);
    expect(MachineView.open).toHaveBeenCalledWith(last);
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
