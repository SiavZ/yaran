/**
 * The shell's root: the route switch, the development-build banner, the lock gate and toasts.
 *
 * The URL hash names the screen; with no route the home is Machines when an org exists and
 * Welcome otherwise. The banner renders above every screen in a build without a publisher
 * domain. While the app lock is engaged the lock screen replaces every screen.
 *
 * - Lifecycle listeners (deep links, resume, lock state) are installed once here.
 *
 * <module-headers:begin>
 * Uses:
 * src/App.tsx
 * ├── @yaran/secure-store:src/index.ts
 * ├── @yaran/ui-kit:src/sonner.tsx
 * ├── src/lib/buildInfo.ts
 * ├── src/lib/lifecycle.ts
 * ├── src/lib/native/machineView.ts
 * ├── src/lib/orgStore.ts
 * ├── src/lib/route.ts
 * ├── src/lib/store.ts
 * ├── src/screens/DevBuildBanner.tsx
 * ├── src/screens/Nav.tsx
 * ├── src/screens/machines/MachineList.tsx
 * ├── src/screens/machines/states/PhoneRemoved.tsx
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
 * External: react
 *
 * Used by:
 * src/App.tsx
 * ├── src/a11y.test.tsx
 * ├── src/main.tsx
 * └── src/screens/screens.test.tsx
 * <module-headers:end>
 */
import { AppLock } from '@yaran/secure-store';
import { Toaster } from '@yaran/ui-kit/sonner';
import { useEffect, useState } from 'react';

import { loadBuildInfo, type ShellBuildInfo } from './lib/buildInfo.ts';
import { installLifecycle, reopenLastMachine } from './lib/lifecycle.ts';
import { MachineView } from './lib/native/machineView.ts';
import { orgStore } from './lib/orgStore.ts';
import { navigate, useRoute, type Route } from './lib/route.ts';
import { useStore } from './lib/store.ts';
import { DevBuildBanner } from './screens/DevBuildBanner.tsx';
import { Nav } from './screens/Nav.tsx';
import { MachineList } from './screens/machines/MachineList.tsx';
import { PhoneRemoved } from './screens/machines/states/PhoneRemoved.tsx';
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
  const [build, setBuild] = useState<ShellBuildInfo | null>(null);
  const [locked, setLocked] = useState(false);

  useEffect(() => {
    let teardown: (() => void) | null = null;
    let live = true;
    void loadBuildInfo().then((b) => live && setBuild(b));
    void installLifecycle(setLocked).then((t) => (live ? (teardown = t) : t()));
    void AppLock.status().then(async (s) => {
      if (!live) return;
      setLocked(s.locked);
      if (!s.locked) await reopenLastMachine();
    });
    // Control URLs from inside a machine (Phase 15) close it with a reason the shell routes.
    void MachineView.addListener('closed', (e) => {
      if (e.reason === 'settings') navigate({ name: 'settings' });
      if (e.reason === 'home') navigate({ name: 'machines' });
    });
    return () => {
      live = false;
      teardown?.();
    };
  }, []);

  const current: Route = route ?? (orgs.length > 0 ? { name: 'machines' } : { name: 'welcome' });
  const home = current.name === 'machines' || current.name === 'orgs' || current.name === 'settings' ? current.name : null;
  return (
    <div className="flex min-h-dvh flex-col bg-background pt-[env(safe-area-inset-top)] text-foreground">
      {build?.callback.mode === 'dev' && <DevBuildBanner />}
      {locked ? <LockScreen onUnlocked={() => setLocked(false)} /> : <Screen route={current} />}
      {!locked && home && <Nav active={home} />}
      <Toaster />
    </div>
  );
}
