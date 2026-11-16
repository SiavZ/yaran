/**
 * Tests for shell settings persistence and defaults.
 *
 * <module-headers:begin>
 * Uses:
 * src/lib/settingsStore.test.ts
 * ├── src/lib/settingsStore.ts
 * └── src/test/setup.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test in mobile/app)
 * <module-headers:end>
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS, loadSettings, settingsStore, updateSettings } from './settingsStore.ts';
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
});
