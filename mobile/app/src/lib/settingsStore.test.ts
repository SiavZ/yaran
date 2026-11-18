/**
 * Tests for shell settings persistence and defaults.
 *
 * <module-headers:begin>
 * Uses:
 * src/lib/settingsStore.test.ts
 * ├── @yaran/secure-store:src/index.ts
 * ├── src/lib/orgStore.ts
 * ├── src/lib/settingsStore.ts
 * └── src/test/setup.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test in mobile/app)
 * <module-headers:end>
 */
import { SecureStore } from '@yaran/secure-store';
import { describe, expect, it, vi } from 'vitest';

import { eraseEverything } from './orgStore.ts';

import { DEFAULT_SETTINGS, forgetLastMachineOf, loadSettings, settingsStore, updateSettings } from './settingsStore.ts';
import { vault } from '../test/setup.ts';

describe('settingsStore', () => {
  it('defaults when nothing is saved', async () => {
    expect(await loadSettings()).toEqual(DEFAULT_SETTINGS);
  });
  it('round-trips an update', async () => {
    await updateSettings({ reopenLastMachine: true });
    settingsStore.set(DEFAULT_SETTINGS);
    expect((await loadSettings()).reopenLastMachine).toBe(true);
  });
  it('ignores malformed fields', async () => {
    vault.set('settings/shell', JSON.stringify({ reopenLastMachine: 'yes', lastMachine: { orgId: 1 } }));
    expect(await loadSettings()).toEqual(DEFAULT_SETTINGS);
  });
  it('keeps an org last machine saved before direct machines existed, and reads a direct one', async () => {
    vault.set('settings/shell', JSON.stringify({ lastMachine: { orgId: 'https://cp.example.com', machineId: 'm', host: 'm.example.com', extra: 1 } }));
    expect((await loadSettings()).lastMachine).toEqual({ orgId: 'https://cp.example.com', machineId: 'm', host: 'm.example.com' });
    vault.set('settings/shell', JSON.stringify({ lastMachine: { directId: 'd1' } }));
    expect((await loadSettings()).lastMachine).toEqual({ directId: 'd1' });
  });
});

describe('settings writes are inside the erase barrier', () => {
  const LAST = { orgId: 'https://cp.example.com', machineId: 'm', host: 'm.example.com' };
  function holdNextWrite() {
    const real = vi.mocked(SecureStore.set).getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vi.mocked(SecureStore.set).mockImplementationOnce(async (o) => (await gate, real(o)));
    return () => release();
  }

  it('a write held across an erase lands before the wipe, so disk and memory both end at the defaults', async () => {
    const release = holdNextWrite();
    const writing = updateSettings({ lastMachine: LAST, reopenLastMachine: true });
    const queued = updateSettings({ locale: 'fi' });
    await new Promise((r) => setTimeout(r, 0));
    let erased = false;
    const erasing = eraseEverything().then(() => (erased = true));
    await expect(updateSettings({ reopenLastMachine: true })).rejects.toMatchObject({ code: 'erased' });
    await new Promise((r) => setTimeout(r, 10));
    expect(erased).toBe(false);
    release();
    await erasing;
    await expect(writing).rejects.toMatchObject({ code: 'erased' });
    await expect(queued).rejects.toMatchObject({ code: 'erased' });
    expect(vault.get('settings/shell')).toBeUndefined();
    expect(settingsStore.get()).toEqual(DEFAULT_SETTINGS);
    await updateSettings({ reopenLastMachine: true });
    expect(JSON.parse(vault.get('settings/shell')!).reopenLastMachine).toBe(true);
  });

  it('a write that fails while the erase drains it does not strand the barrier, and later writes work', async () => {
    let fail!: () => void;
    const gate = new Promise<void>((r) => (fail = r));
    vi.mocked(SecureStore.set).mockImplementationOnce(async () => {
      await gate;
      throw Object.assign(new Error('disk'), { code: 'native_error' });
    });
    const failing = updateSettings({ lastMachine: LAST });
    await new Promise((r) => setTimeout(r, 0));
    const erasing = eraseEverything();
    fail();
    await expect(failing).rejects.toMatchObject({ code: 'native_error' });
    await erasing;
    expect(settingsStore.get()).toEqual(DEFAULT_SETTINGS);
    await updateSettings({ locale: 'fi' });
    expect(settingsStore.get().locale).toBe('fi');
  });

  it('forgetting the last machine is decided in its turn, against the settings as they are then', async () => {
    await updateSettings({ lastMachine: LAST });
    const release = holdNextWrite();
    const other = updateSettings({ lastMachine: { directId: 'd1' } });
    const forgetting = forgetLastMachineOf(LAST.orgId);
    release();
    await Promise.all([other, forgetting]);
    expect(settingsStore.get().lastMachine).toEqual({ directId: 'd1' });
  });
});
