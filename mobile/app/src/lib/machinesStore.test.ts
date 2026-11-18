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

import { dropMachine, forgetOrgMachines, machineHosts, machinesStore, refreshMachines, resetMachines } from './machinesStore.ts';
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
  it('a refresh that fails after a drop keeps the machine dropped', async () => {
    request.mockResolvedValueOnce({ kind: 'ok', status: 200, body: last });
    await refreshMachines('o');
    let fail!: (v: { kind: 'offline' }) => void;
    request.mockImplementationOnce(() => new Promise((r) => (fail = r)));
    const pending = refreshMachines('o');
    dropMachine('o', last.items[0]!.id);
    fail({ kind: 'offline' });
    expect(await pending).toEqual({ kind: 'offline' });
    expect(machinesStore.get().o?.machines.map((m) => m.id)).not.toContain(last.items[0]!.id);
    expect(machinesStore.get().o?.state).toBe('failed');
  });
  it('a rejected refresh after a drop keeps the machine dropped and frees the next refresh', async () => {
    request.mockResolvedValueOnce({ kind: 'ok', status: 200, body: last });
    await refreshMachines('o');
    let reject!: (e: Error) => void;
    request.mockImplementationOnce(() => new Promise((_, r) => (reject = r)));
    const pending = refreshMachines('o');
    dropMachine('o', last.items[0]!.id);
    reject(new Error('native'));
    await pending;
    expect(machinesStore.get().o?.machines).toHaveLength(last.items.length - 1);
    request.mockResolvedValueOnce({ kind: 'ok', status: 200, body: last });
    expect(await refreshMachines('o')).toBeNull();
  });
  it('a successful refresh sent before a drop does not bring the dropped machine back', async () => {
    request.mockResolvedValueOnce({ kind: 'ok', status: 200, body: last });
    await refreshMachines('o');
    const gone = last.items[0]!.id;
    let answer!: (v: { kind: 'ok'; status: number; body: unknown }) => void;
    request.mockImplementationOnce(() => new Promise((r) => (answer = r)));
    const old = refreshMachines('o');
    dropMachine('o', gone);
    answer({ kind: 'ok', status: 200, body: last });
    expect(await old).toBeNull();
    expect(machinesStore.get().o?.machines.map((m) => m.id)).not.toContain(gone);
  });
  it('a refresh asked for after a drop waits for a fresh request instead of joining the old one', async () => {
    request.mockResolvedValueOnce({ kind: 'ok', status: 200, body: last });
    await refreshMachines('o');
    const gone = last.items[0]!.id;
    let answer!: (v: { kind: 'ok'; status: number; body: unknown }) => void;
    request.mockImplementationOnce(() => new Promise((r) => (answer = r)));
    const old = refreshMachines('o');
    dropMachine('o', gone);
    // The server now lists the machine again (re-added): the fresh request must show it.
    request.mockResolvedValueOnce({ kind: 'ok', status: 200, body: last });
    const after = refreshMachines('o');
    const again = refreshMachines('o');
    answer({ kind: 'ok', status: 200, body: last });
    await old;
    expect(await after).toBeNull();
    await again;
    expect(request).toHaveBeenCalledTimes(3);
    expect(machinesStore.get().o?.machines.map((m) => m.id)).toContain(gone);
  });
});

describe('an org removed and added again while its old request is out', () => {
  type Answer = Parameters<typeof request.mockResolvedValue>[0];
  function pending() {
    let answer!: (v: Answer) => void;
    request.mockImplementationOnce(() => new Promise((r) => (answer = r)));
    return (v: Answer) => answer(v);
  }
  const none = { ...last, items: [] };

  it.each([
    ['device_revoked', { kind: 'device_revoked' } as Answer],
    ['an error', { kind: 'offline' } as Answer],
    ['a success with another list', { kind: 'ok', status: 200, body: none } as Answer],
  ])('the old request answering %s late delivers nothing to the new org', async (_, oldAnswer) => {
    const answerOld = pending();
    const old = refreshMachines('o');
    forgetOrgMachines('o');
    const answerNew = pending();
    const fresh = refreshMachines('o');
    expect(request).toHaveBeenCalledTimes(2);
    answerNew({ kind: 'ok', status: 200, body: last });
    expect(await fresh).toBeNull();
    answerOld(oldAnswer);
    // Stale: no failure for a caller to act on (a device_revoked here would remove the new org).
    expect(await old).toBeNull();
    expect(machinesStore.get().o).toMatchObject({ state: 'ready', machines: last.items });
  });

  it('a follow-up queued by a drop on the old org never runs', async () => {
    request.mockResolvedValueOnce({ kind: 'ok', status: 200, body: last });
    await refreshMachines('o');
    const answerOld = pending();
    void refreshMachines('o');
    dropMachine('o', last.items[0]!.id);
    const followUp = refreshMachines('o');
    forgetOrgMachines('o');
    answerOld({ kind: 'ok', status: 200, body: last });
    expect(await followUp).toBeNull();
    expect(request).toHaveBeenCalledTimes(2);
    expect(machinesStore.get().o).toBeUndefined();
  });

  it('Erase everything (reset) retires every request the same way', async () => {
    const answerOld = pending();
    const old = refreshMachines('o');
    resetMachines();
    answerOld({ kind: 'device_revoked' });
    expect(await old).toBeNull();
    expect(machinesStore.get()).toEqual({});
  });
});
