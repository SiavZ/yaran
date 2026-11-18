/**
 * The shell's root: the route switch, the development-build banner, the lock gate and toasts.
 *
 * The URL hash names the screen; with no route the home is Machines when an org or a direct
 * machine exists and Welcome otherwise. A direct window that closes because a different yaran
 * answers at its address raises the Keep / Remove dialog. The banner renders above every screen in a build without a publisher
 * domain. While the app lock is engaged the lock screen replaces every screen.
 *
 * - Lifecycle listeners (deep links, resume, lock state) are installed once per mount here and
 *   removed on unmount. Launch order: the lock state is read at once; once the launch link (if
 *   any) is handled, an unlocked start shows a waiting share, else keeps a Confirm screen or a
 *   link's target, else reopens the last machine. A locked or unreadable lock state opens nothing.
 *
 * <module-headers:begin>
 * Uses:
 * src/App.tsx
 * ├── @yaran/secure-store:src/index.ts
 * ├── @yaran/ui-kit:src/sonner.tsx
 * ├── src/lib/buildInfo.ts
 * ├── src/lib/directStore.ts
 * ├── src/lib/lifecycle.ts
 * ├── src/lib/native/machineView.ts
 * ├── src/lib/notify.ts
 * ├── src/lib/openMachine.ts
 * ├── src/lib/orgStore.ts
 * ├── src/lib/route.ts
 * ├── src/lib/share.ts
 * ├── src/lib/store.ts
 * ├── src/screens/DevBuildBanner.tsx
 * ├── src/screens/Nav.tsx
 * ├── src/screens/machines/InstanceChangedDialog.tsx
 * ├── src/screens/machines/MachineList.tsx
 * ├── src/screens/machines/MachineRoutes.tsx
 * ├── src/screens/machines/ShareTarget.tsx
 * ├── src/screens/machines/directText.tsx
 * ├── src/screens/machines/states/PhoneRemoved.tsx
 * ├── src/screens/onboarding/ConfirmMachine.tsx
 * ├── src/screens/onboarding/ConfirmOrg.tsx
 * ├── src/screens/onboarding/EnterUrl.tsx
 * ├── src/screens/onboarding/ScanQr.tsx
 * ├── src/screens/onboarding/Welcome.tsx
 * ├── src/screens/orgs/OrgList.tsx
 * ├── src/screens/settings/Diagnostics.tsx
 * ├── src/screens/settings/LanguageSettings.tsx
 * ├── src/screens/settings/Licenses.tsx
 * ├── src/screens/settings/LockScreen.tsx
 * ├── src/screens/settings/SecuritySettings.tsx
 * └── src/screens/settings/Settings.tsx
 * External: @lingui/core, react
 *
 * Used by:
 * src/App.tsx
 * ├── src/a11y.test.tsx
 * ├── src/approvalNavigation.test.tsx
 * ├── src/continuations.test.tsx
 * ├── src/explicitOpen.test.tsx
 * ├── src/launch.test.tsx
 * ├── src/main.tsx
 * ├── src/modalNavigation.test.tsx
 * ├── src/orgStaging.test.tsx
 * ├── src/orgStagingSettle.test.tsx
 * ├── src/reopenPriority.test.tsx
 * ├── src/screens/machines/instanceChanged.test.tsx
 * ├── src/screens/machines/upgradeRequired.test.tsx
 * ├── src/screens/screens.test.tsx
 * ├── src/screens/settings/settings.test.tsx
 * └── src/shareBatch.test.tsx
 * <module-headers:end>
 */
import { AppLock } from '@yaran/secure-store';
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { Toaster } from '@yaran/ui-kit/sonner';
import { useCallback, useEffect, useRef, useState } from 'react';

import { loadBuildInfo, type ShellBuildInfo } from './lib/buildInfo.ts';
import { installLifecycle, startUnlocked, type Lifecycle } from './lib/lifecycle.ts';
import { MachineView } from './lib/native/machineView.ts';
import { directStore } from './lib/directStore.ts';
import { notify } from './lib/notify.ts';
import { closedDestination, instanceChangedTarget, machineChoices } from './lib/openMachine.ts';
import { routeToPendingShare, shareArrivals } from './lib/share.ts';
import { orgStore } from './lib/orgStore.ts';
import { navigate, useRoute, type Route } from './lib/route.ts';
import { useStore } from './lib/store.ts';
import { DevBuildBanner } from './screens/DevBuildBanner.tsx';
import { Nav } from './screens/Nav.tsx';
import { InstanceChangedDialog } from './screens/machines/InstanceChangedDialog.tsx';
import { MachineList } from './screens/machines/MachineList.tsx';
import { MachineRoutes } from './screens/machines/MachineRoutes.tsx';
import { upgradeRequiredClosed } from './screens/machines/directText.tsx';
import { ShareTarget } from './screens/machines/ShareTarget.tsx';
import { PhoneRemoved } from './screens/machines/states/PhoneRemoved.tsx';
import { ConfirmMachine } from './screens/onboarding/ConfirmMachine.tsx';
import { ConfirmOrg } from './screens/onboarding/ConfirmOrg.tsx';
import { EnterUrl } from './screens/onboarding/EnterUrl.tsx';
import { ScanQr } from './screens/onboarding/ScanQr.tsx';
import { Welcome } from './screens/onboarding/Welcome.tsx';
import { OrgList } from './screens/orgs/OrgList.tsx';
import { Diagnostics } from './screens/settings/Diagnostics.tsx';
import { LanguageSettings } from './screens/settings/LanguageSettings.tsx';
import { Licenses } from './screens/settings/Licenses.tsx';
import { LockScreen } from './screens/settings/LockScreen.tsx';
import { SecuritySettings } from './screens/settings/SecuritySettings.tsx';
import { Settings } from './screens/settings/Settings.tsx';

function Screen({ route }: { route: Route }) {
  switch (route.name) {
    case 'welcome':
      return <Welcome />;
    case 'scan':
      return <ScanQr />;
    case 'enter-url':
      return <EnterUrl />;
    case 'confirm':
      return <ConfirmOrg key={route.url} url={route.url} />;
    case 'enter-machine':
      return <EnterUrl key="machine" machine />;
    case 'confirm-machine':
      return <ConfirmMachine key={route.host} host={route.host} />;
    case 'machine-routes':
      return <MachineRoutes key={route.id} id={route.id} />;
    case 'share':
      return <ShareTarget />;
    case 'machines':
      return <MachineList />;
    case 'orgs':
      return <OrgList />;
    case 'settings':
      return <Settings />;
    case 'settings-page':
      switch (route.page) {
        case 'security':
          return <SecuritySettings />;
        case 'language':
          return <LanguageSettings />;
        case 'diagnostics':
          return <Diagnostics />;
        case 'licenses':
          return <Licenses />;
      }
      break;
    case 'removed':
      return <PhoneRemoved org={route.org} />;
  }
}

export function App() {
  const route = useRoute();
  const { orgs } = useStore(orgStore);
  const direct = useStore(directStore).machines;
  const [changed, setChanged] = useState<ReturnType<typeof instanceChangedTarget>>(null);
  const [build, setBuild] = useState<ShellBuildInfo | null>(null);
  const [locked, setLocked] = useState(false);

  // The lifecycle of the current mount; the lock screen hands it the unlock.
  const life = useRef<Lifecycle | null>(null);
  // Lock events seen so far, and the newest known state (null: unknown or unreadable).
  const lockEvents = useRef(0);
  const knownLocked = useRef<boolean | null>(null);
  const lock = useCallback((locked: boolean) => {
    lockEvents.current += 1;
    knownLocked.current = locked;
    setLocked(locked);
  }, []);

  useEffect(() => {
    let live = true;
    const alive = () => live;
    // What is on screen, and the machines chosen, before any startup await: a move or a choice
    // made from here on is newer than the automatic reopen, which then gives way.
    const startHash = window.location.hash;
    const startChoices = machineChoices();
    const startShares = shareArrivals();
    void loadBuildInfo().then((b) => live && setBuild(b));
    // A read of the lock state counts only when no lock event (native, or Unlock on the lock
    // screen) arrived while it was out: the event is newer, and a read never overrides it.
    const read = async (): Promise<boolean | null> => {
      const at = lockEvents.current;
      const s = await AppLock.status().catch(() => null);
      if (at !== lockEvents.current) return knownLocked.current;
      knownLocked.current = s?.locked ?? null;
      if (live && s) setLocked(s.locked);
      return knownLocked.current;
    };
    // Read now so the lock screen never waits on a slow launch URL; null means unreadable.
    const atStart = read();
    void (async () => {
      const installed = await installLifecycle(lock, alive);
      if (!live) return installed.teardown();
      life.current = installed;
      const startedLocked = (await atStart) !== false;
      // The lock may have changed while the listeners went in (an Unlock on the lock screen
      // before `life` existed): decide on the state as it is now, read again. `read` has already
      // shown it, a lock included; locked or unreadable opens nothing, the unlock decides.
      const now = await read();
      if (!live || now !== false) return;
      // A held link is released either way. A link arriving from here on is newer than the launch.
      installed.links.release();
      const links = installed.links.arrivals();
      // Anything newer than the launch itself (a link, a move, a machine chosen, a file share,
      // each counted at its arrival) outranks the automatic steps: the startup share and the reopen.
      const newer = () => installed.links.arrivals() !== links || window.location.hash !== startHash || machineChoices() !== startChoices || shareArrivals() !== startShares;
      // Started locked: the launch's own share step, under the launch's eligibility (a move made
      // after the unlock, before this point, wins); no reopen after an unlock.
      if (startedLocked) return void routeToPendingShare(() => alive() && !newer());
      if (await installed.links.settled()) return;
      await startUnlocked(alive, newer);
    })();
    // Control URLs from inside a machine (Phase 15) close it with a reason the shell routes.
    const closed = MachineView.addListener('closed', (e) => {
      // Still registering when the App went away: the handle is removed late, and the event is not this App's.
      if (!live) return;
      const to = closedDestination(e);
      navigate({ name: to === 'org_sign_in' ? 'orgs' : to });
      // A direct window's own codes: the recorded instance no longer answers, or no route did.
      if (e.reason === 'error' && e.code === 'instance_changed') {
        const target = instanceChangedTarget(e, directStore.get().machines);
        // Without a context that pins one record, say what happened and offer nothing destructive.
        if (target) setChanged(target);
        else notify('warning', i18n._(msg`A different yaran answered than the machine this phone added, so its window closed. Open the machine again to check it.`));
      }
      if (e.reason === 'error' && e.code === 'no_route') {
        notify('error', i18n._(msg`None of the ways to reach that machine answered as it. Check that yaran runs there, then try again.`));
      }
      // The machine's yaran predates the app's own sign-in: its record stays, nothing is asked.
      if (e.reason === 'error' && e.code === 'upgrade_required') notify('warning', upgradeRequiredClosed(e.host));
    });
    return () => {
      live = false;
      life.current?.teardown();
      life.current = null;
      void closed.then((h) => h.remove());
    };
  }, [lock]);

  const current: Route = route ?? (orgs.length > 0 || direct.length > 0 ? { name: 'machines' } : { name: 'welcome' });
  const home = current.name === 'machines' || current.name === 'orgs' || current.name === 'settings' ? current.name : null;
  return (
    <div className="flex min-h-dvh flex-col bg-card pt-[env(safe-area-inset-top)] text-foreground">
      {build?.callback.mode === 'dev' && <DevBuildBanner />}
      {locked ? (
        <LockScreen
          onUnlocked={() => {
            lock(false);
            life.current?.afterUnlock();
          }}
        />
      ) : (
        <Screen route={current} />
      )}
      {!locked && home && <Nav active={home} />}
      {!locked && <InstanceChangedDialog target={changed} onClose={() => setChanged(null)} />}
      <Toaster />
    </div>
  );
}
