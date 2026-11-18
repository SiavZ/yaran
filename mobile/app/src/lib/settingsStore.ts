/**
 * Shell settings that live in JS: reopen-last-machine, the language, and the last machine
 * (an org machine, or a direct machine by its record id).
 *
 * Security settings (app lock, passcode fallback, lock grace, screen privacy) are native
 * state read through the secure-store plugin, because they must apply before the shell loads.
 *
 * - Stored in the vault's `settings` namespace, `standard` class.
 *
 * <module-headers:begin>
 * Uses:
 * src/lib/settingsStore.ts
 * ├── @yaran/secure-store:src/index.ts
 * ├── src/lib/erasure.ts
 * └── src/lib/store.ts
 * External: none
 *
 * Used by:
 * src/lib/settingsStore.ts
 * ├── src/approvalNavigation.test.tsx
 * ├── src/continuations.test.tsx
 * ├── src/explicitOpen.test.tsx
 * ├── src/launch.test.tsx
 * ├── src/lib/directStore.test.ts
 * ├── src/lib/directStore.ts
 * ├── src/lib/lifecycle.test.ts
 * ├── src/lib/lifecycle.ts
 * ├── src/lib/orgStore.test.ts
 * ├── src/lib/orgStore.ts
 * ├── src/lib/settingsStore.test.ts
 * ├── src/main.tsx
 * ├── src/modalNavigation.test.tsx
 * ├── src/orgStaging.test.tsx
 * ├── src/orgStagingSettle.test.tsx
 * ├── src/push/pushWiring.test.ts
 * ├── src/push/pushWiring.ts
 * ├── src/reopenPriority.test.tsx
 * ├── src/screens/machines/DirectSection.tsx
 * ├── src/screens/machines/MachineList.tsx
 * ├── src/screens/settings/LanguageSettings.tsx
 * ├── src/screens/settings/Settings.tsx
 * ├── src/screens/settings/settings.test.tsx
 * └── src/shareBatch.test.tsx
 * <module-headers:end>
 */
import { SecureStore } from '@yaran/secure-store';

import { eraseEpoch, erasing } from './erasure.ts';
import { createStore } from './store.ts';

export interface ShellSettings {
  reopenLastMachine: boolean;
  locale: string;
  lastMachine: LastMachine | null;
}

/** The org form predates direct machines, so it carries no tag; a direct one names its record. */
export type LastMachine = { orgId: string; machineId: string; host: string } | { directId: string };

export const DEFAULT_SETTINGS: ShellSettings = { reopenLastMachine: false, locale: 'en', lastMachine: null };
const NS = { namespace: 'settings', key: 'shell' } as const;
export const settingsStore = createStore<ShellSettings>(DEFAULT_SETTINGS);

/** Reads saved settings; unknown or malformed fields fall back to their defaults. */
export async function loadSettings(): Promise<ShellSettings> {
  const { value } = await SecureStore.get(NS).catch(() => ({ value: null }));
  let raw: Record<string, unknown> = {};
  try {
    const parsed: unknown = value === null ? {} : JSON.parse(value);
    if (typeof parsed === 'object' && parsed !== null) raw = parsed as Record<string, unknown>;
  } catch {
    raw = {};
  }
  const last = raw.lastMachine as Record<string, unknown> | null | undefined;
  const settings: ShellSettings = {
    reopenLastMachine: typeof raw.reopenLastMachine === 'boolean' ? raw.reopenLastMachine : DEFAULT_SETTINGS.reopenLastMachine,
    locale: typeof raw.locale === 'string' ? raw.locale : DEFAULT_SETTINGS.locale,
    lastMachine:
      last && typeof last.orgId === 'string' && typeof last.machineId === 'string' && typeof last.host === 'string'
        ? { orgId: last.orgId, machineId: last.machineId, host: last.host }
        : last && typeof last.directId === 'string'
          ? { directId: last.directId }
          : null,
  };
  settingsStore.set(settings);
  return settings;
}

// One settings write at a time, each computed from the settings as they are when its turn comes.
let queue: Promise<unknown> = Promise.resolve();

const erased = () => Object.assign(new Error('Erase everything is running'), { code: 'erased' });

/**
 * Writes `patch` (or what `change` makes of the current settings; null writes nothing) in turn.
 * Inside the erase barrier: refused while an erase runs, and a write from before an erase never
 * lands after it (erase drains this queue before its wipe, and a stale write shows nothing).
 */
export function updateSettings(patch: Partial<ShellSettings> | ((current: ShellSettings) => Partial<ShellSettings> | null)): Promise<void> {
  if (erasing()) return Promise.reject(erased());
  const asOf = eraseEpoch();
  const run = queue.then(async () => {
    if (asOf !== eraseEpoch()) throw erased();
    const current = settingsStore.get();
    const change = typeof patch === 'function' ? patch(current) : patch;
    if (change === null) return;
    const next = { ...current, ...change };
    await SecureStore.set({ ...NS, value: JSON.stringify(next), protection: 'standard' });
    if (asOf !== eraseEpoch()) throw erased();
    settingsStore.set(next);
  });
  queue = run.catch(() => undefined);
  return run;
}

/** Erase: wait for every settings write already queued or running. */
export function drainSettings(): Promise<unknown> {
  return queue;
}

export function forgetLastMachineOf(orgId: string): Promise<void> {
  return updateSettings(({ lastMachine: last }) => (last && 'orgId' in last && last.orgId === orgId ? { lastMachine: null } : null));
}

export function forgetLastDirect(id: string): Promise<void> {
  return updateSettings(({ lastMachine: last }) => (last && 'directId' in last && last.directId === id ? { lastMachine: null } : null));
}

export function resetSettings(): void {
  settingsStore.set(DEFAULT_SETTINGS);
}
