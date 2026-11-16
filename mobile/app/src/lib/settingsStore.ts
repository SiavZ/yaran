/**
 * Shell settings that live in JS: reopen-last-machine, the language, and the last machine.
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
 * └── src/lib/store.ts
 * External: none
 *
 * Used by:
 * src/lib/settingsStore.ts
 * ├── src/lib/lifecycle.test.ts
 * ├── src/lib/lifecycle.ts
 * ├── src/lib/orgStore.test.ts
 * ├── src/lib/orgStore.ts
 * ├── src/lib/settingsStore.test.ts
 * ├── src/main.tsx
 * ├── src/push/pushWiring.ts
 * ├── src/screens/machines/MachineList.tsx
 * ├── src/screens/settings/LanguageSettings.tsx
 * └── src/screens/settings/Settings.tsx
 * <module-headers:end>
 */
import { SecureStore } from '@yaran/secure-store';

import { createStore } from './store.ts';

export interface ShellSettings {
  reopenLastMachine: boolean;
  locale: string;
  lastMachine: { orgId: string; machineId: string; host: string } | null;
}

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
  const last = raw.lastMachine as ShellSettings['lastMachine'] | undefined;
  const settings: ShellSettings = {
    reopenLastMachine: typeof raw.reopenLastMachine === 'boolean' ? raw.reopenLastMachine : DEFAULT_SETTINGS.reopenLastMachine,
    locale: typeof raw.locale === 'string' ? raw.locale : DEFAULT_SETTINGS.locale,
    lastMachine:
      last && typeof last.orgId === 'string' && typeof last.machineId === 'string' && typeof last.host === 'string' ? last : null,
  };
  settingsStore.set(settings);
  return settings;
}

export async function updateSettings(patch: Partial<ShellSettings>): Promise<void> {
  const next = { ...settingsStore.get(), ...patch };
  await SecureStore.set({ ...NS, value: JSON.stringify(next), protection: 'standard' });
  settingsStore.set(next);
}

export async function forgetLastMachineOf(orgId: string): Promise<void> {
  if (settingsStore.get().lastMachine?.orgId === orgId) await updateSettings({ lastMachine: null });
}

export function resetSettings(): void {
  settingsStore.set(DEFAULT_SETTINGS);
}
