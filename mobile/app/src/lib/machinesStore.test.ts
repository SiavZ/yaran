/**
 * Tests for the machine cache: refresh states, coalescing and drops.
 *
 * <module-headers:begin>
 * Uses:
 * src/lib/machinesStore.test.ts
 * ├── cloud/protocol/fixtures/api/MachinePage.json
 * ├── src/lib/machinesStore.ts
 * └── src/lib/native/machineView.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test in mobile/app)
 * <module-headers:end>
 */
import machinePages from '@yaran/protocol/fixtures/api/MachinePage.json' with { type: 'json' };
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { dropMachine, machineHosts, machinesStore, refreshMachines, resetMachines } from './machinesStore.ts';
import { Session } from './native/machineView.ts';

const last = machinePages.valid.find((v) => v.value.next_cursor === null)!.value;
const request = vi.mocked(Session.request);

beforeEach(resetMachines);

describe('machinesStore', () => {
  it('loads a list and records the hosts', async () => {
    request.mockResolvedValueOnce({ kind: 'ok', status: 200, body: last });
    expect(await refreshMachines('o')).toBeNull();
    expect(machinesStore.get().o?.state).toBe('ready');
    expect(machineHosts('o')).toEqual(last.items.map((m) => m.hostname));
  });
  it('keeps the previous list when a refresh fails', async () => {
    request.mockResolvedValueOnce({ kind: 'ok', status: 200, body: last });
    await refreshMachines('o');
    request.mockResolvedValueOnce({ kind: 'offline' });
    expect(await refreshMachines('o')).toEqual({ kind: 'offline' });
    const s = machinesStore.get().o!;
    expect(s.state).toBe('failed');
    expect(s.machines).toHaveLength(last.items.length);
  });
  it('coalesces concurrent refreshes of one org', async () => {
    request.mockResolvedValue({ kind: 'ok', status: 200, body: last });
    await Promise.all([refreshMachines('o'), refreshMachines('o')]);
    expect(request).toHaveBeenCalledTimes(1);
    request.mockReset();
  });
  it('drops a removed machine from the cache', async () => {
    request.mockResolvedValueOnce({ kind: 'ok', status: 200, body: last });
    await refreshMachines('o');
    dropMachine('o', last.items[0]!.id);
    expect(machinesStore.get().o?.machines).toHaveLength(last.items.length - 1);
  });
});
