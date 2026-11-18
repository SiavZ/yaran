/**
 * App lifecycle wiring: deep links, resume refresh, lock state, shares and reopening the last machine.
 *
 * On resume every org's machine list refreshes and its push registration reconciles (the lock check itself is native: the
 * activity/scene delegate engages the cover, and `AppLock`'s `lockStateChanged` event tells
 * the shell to show the lock screen). On launch, when "Reopen last machine" is on and the
 * app is not locked, the last opened machine (org or direct) opens again, unless a share is
 * waiting (the share screen shows) or a launch link claimed the launch (its screen or machine
 * shows). After an unlock, a link held by the lock opens once and a waiting share shows.
 *
 * - Every listener is removed by the returned teardown.
 * - Push: the native listeners (taps, endpoint changes, queued registrations) install here.
 *
 * <module-headers:begin>
 * Uses:
 * src/lib/lifecycle.ts
 * ├── @yaran/secure-store:src/index.ts
 * ├── src/lib/deepLinks.ts
 * ├── src/lib/diagnostics.ts
 * ├── src/lib/directStore.ts
 * ├── src/lib/machinesStore.ts
 * ├── src/lib/native/machineView.ts
 * ├── src/lib/openMachine.ts
 * ├── src/lib/orgStore.ts
 * ├── src/lib/route.ts
 * ├── src/lib/settingsStore.ts
 * ├── src/lib/share.ts
 * └── src/push/pushWiring.ts
 * External: @capacitor/app
 *
 * Used by:
 * src/lib/lifecycle.ts
 * ├── src/App.tsx
 * ├── src/lib/lifecycle.test.ts
 * └── src/push/pushRaces.test.ts
 * <module-headers:end>
 */
import { App } from '@capacitor/app';
import { AppLock } from '@yaran/secure-store';

import { installDeepLinks, type DeepLinks } from './deepLinks.ts';
import { log } from './diagnostics.ts';
import { findDirect } from './directStore.ts';
import { machinesStore, refreshMachines } from './machinesStore.ts';
import { MachineView } from './native/machineView.ts';
import { machineChoices, openDirect, openMachine, type OpenMachineResult } from './openMachine.ts';
import { parseRoute } from './route.ts';
import { onShareReceived, routeToPendingShare } from './share.ts';
import { installPush, reconcileAllPush } from '../push/pushWiring.ts';
import { orgStore } from './orgStore.ts';
import { settingsStore } from './settingsStore.ts';

export function refreshAllOrgs(alive: () => boolean = () => true): void {
  for (const org of orgStore.get().orgs) void refreshMachines(org.id);
  reconcileAllPush(alive);
}

/** Opens the last machine when the setting is on and the machine is still on this phone. */
export async function reopenLastMachine(alive: () => boolean = () => true): Promise<boolean> {
  const { reopenLastMachine, lastMachine } = settingsStore.get();
  if (!reopenLastMachine || lastMachine === null) return false;
  try {
    let opened: OpenMachineResult;
    if ('directId' in lastMachine) {
      if (!findDirect(lastMachine.directId) || !alive()) return false;
      opened = await openDirect(lastMachine.directId);
    } else {
      if (!orgStore.get().orgs.some((o) => o.id === lastMachine.orgId)) return false;
      // The host comes from a fresh authenticated list, never from the saved setting.
      if (!machinesStore.get()[lastMachine.orgId]?.machines.length) await refreshMachines(lastMachine.orgId);
      if (!alive()) return false;
      opened = await openMachine(lastMachine.orgId, lastMachine.machineId);
    }
    if (!opened.ok) log('warn', `did not reopen the last machine: ${opened.reason}`);
    return opened.ok;
  } catch (err) {
    log('warn', `could not reopen the last machine: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * Launch, once unlocked and after every launch link was handled: a waiting share wins, then a
 * Confirm screen already on show, and only then is the last machine reopened. `alive` stops it
 * once the shell is gone; `superseded` once a newer link arrived. Anything that moves the screen
 * while the reopen waits (a link, a share, the user) is newer too, and the reopen gives way.
 */
export async function startUnlocked(alive: () => boolean = () => true, superseded: () => boolean = () => false): Promise<void> {
  const go = () => alive() && !superseded();
  // The startup pull is not an arrival, so it never supersedes itself; a newer move, link, choice
  // or share does, and then neither the startup share nor the reopen replaces it.
  if (!go() || (await routeToPendingShare(go))) return;
  const shown = parseRoute(window.location.hash)?.name;
  if (shown === 'confirm' || shown === 'confirm-machine' || !go()) return;
  const at = window.location.hash;
  await reopenLastMachine(() => go() && window.location.hash === at);
}

export interface Lifecycle {
  /** The deep links of this install; `settled()` says whether a link claimed the launch. */
  links: DeepLinks;
  /** After an unlock: open a held link once, then show a share that waited for the lock. */
  afterUnlock(): void;
  teardown(): void;
}

/**
 * Installs every lifecycle listener; `onLock` receives lock-state changes. `mounted` is the
 * caller's liveness: once it is false nothing fires, and a listener that finishes registering
 * afterwards is removed at once.
 */
export async function installLifecycle(onLock: (locked: boolean) => void, mounted: () => boolean = () => true): Promise<Lifecycle> {
  let removed = false;
  const alive = () => !removed && mounted();
  const handles: { remove(): unknown }[] = [];
  const teardown = () => {
    removed = true;
    for (const h of handles.splice(0)) void h.remove();
  };
  // The lock listener comes first, so an unlock while the launch URL is still being read is
  // seen; until the links exist there is nothing held to release (the caller reconciles).
  let links: DeepLinks | null = null;
  // A share's own routing yields to anything newer than the moment it was asked for: a move, a
  // link, a machine chosen. Taken at the share's intake, before its status pull.
  const unmoved = () => {
    const hash = window.location.hash;
    const choices = machineChoices();
    const arrivals = links?.arrivals() ?? 0;
    return () => alive() && window.location.hash === hash && machineChoices() === choices && (links?.arrivals() ?? 0) === arrivals;
  };
  const afterUnlock = () => {
    if (!alive()) return;
    links?.release();
    void routeToPendingShare(unmoved());
  };
  handles.push(
    await AppLock.addListener('lockStateChanged', (e) => {
      if (!alive()) return;
      onLock(e.locked);
      if (!e.locked) afterUnlock();
    }),
  );
  if (!alive()) {
    teardown();
    return { links: { settled: async () => false, release() {}, arrivals: () => 0, remove() {} }, afterUnlock, teardown };
  }
  const installed = await installDeepLinks(alive);
  links = installed;
  handles.push(installed);
  const steps: (() => Promise<{ remove(): unknown }>)[] = [
    () => App.addListener('resume', () => alive() && refreshAllOrgs(alive)),
    // Native holds the event until unlock and retains it for a cold start; the pull is the truth.
    () => MachineView.addListener('shareReceived', (e) => alive() && onShareReceived(e, unmoved())),
    async () => ({ remove: await installPush(alive) }),
  ];
  for (const step of steps) {
    if (!alive()) break;
    handles.push(await step());
  }
  if (!alive()) teardown();
  return { links: installed, afterUnlock, teardown };
}
