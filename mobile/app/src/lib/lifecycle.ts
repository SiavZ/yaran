/**
 * App lifecycle wiring: deep links, resume refresh, lock state and reopening the last machine.
 *
 * On resume every org's machine list refreshes (the lock check itself is native: the
 * activity/scene delegate engages the cover, and `AppLock`'s `lockStateChanged` event tells
 * the shell to show the lock screen). On launch, when "Reopen last machine" is on and the
 * app is not locked, the last opened machine opens again through Phase 15's `MachineView`.
 *
 * - Every listener is removed by the returned teardown.
 * - Seam (Phase 16): push reconciliation on foreground hooks into the `resume` listener here.
 *
 * <module-headers:begin>
 * Uses:
 * src/lib/lifecycle.ts
 * ├── @yaran/secure-store:src/index.ts
 * ├── src/lib/deepLinks.ts
 * ├── src/lib/diagnostics.ts
 * ├── src/lib/machinesStore.ts
 * ├── src/lib/openMachine.ts
 * ├── src/lib/orgStore.ts
 * └── src/lib/settingsStore.ts
 * External: @capacitor/app
 *
 * Used by:
 * src/lib/lifecycle.ts
 * ├── src/App.tsx
 * └── src/lib/lifecycle.test.ts
 * <module-headers:end>
 */
import { App } from '@capacitor/app';
import { AppLock } from '@yaran/secure-store';

import { installDeepLinks } from './deepLinks.ts';
import { log } from './diagnostics.ts';
import { machinesStore, refreshMachines } from './machinesStore.ts';
import { openMachine } from './openMachine.ts';
import { orgStore } from './orgStore.ts';
import { settingsStore } from './settingsStore.ts';

export function refreshAllOrgs(): void {
  for (const org of orgStore.get().orgs) void refreshMachines(org.id);
}

/** Opens the last machine when the setting is on and its org is still added. */
export async function reopenLastMachine(): Promise<boolean> {
  const { reopenLastMachine, lastMachine } = settingsStore.get();
  if (!reopenLastMachine || lastMachine === null) return false;
  if (!orgStore.get().orgs.some((o) => o.id === lastMachine.orgId)) return false;
  try {
    // The host comes from a fresh authenticated list, never from the saved setting.
    if (!machinesStore.get()[lastMachine.orgId]?.machines.length) await refreshMachines(lastMachine.orgId);
    const opened = await openMachine(lastMachine.orgId, lastMachine.machineId);
    if (!opened.ok) log('warn', `did not reopen the last machine: ${opened.reason}`);
    return opened.ok;
  } catch (err) {
    log('warn', `could not reopen the last machine: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** Installs every lifecycle listener; `onLock` receives lock-state changes. */
export async function installLifecycle(onLock: (locked: boolean) => void): Promise<() => void> {
  const removeLinks = await installDeepLinks();
  const resume = await App.addListener('resume', refreshAllOrgs);
  const lock = await AppLock.addListener('lockStateChanged', (e) => onLock(e.locked));
  return () => {
    removeLinks();
    void resume.remove();
    void lock.remove();
  };
}
