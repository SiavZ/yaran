/**
 * Build facts the shell reads once at start: the sign-in callback mode and the flavor.
 *
 * `Session.callbackMode()` (Phase 15) says whether this binary was compiled with a publisher
 * domain; without one, sign-in replies use the claimable `yaranapp://auth/callback` scheme
 * and every screen shows the development-build banner (D8, T36). `BuildInfo.get()` gives the
 * flavor (the GitHub releases link is `foss`-only, T50) and the e2e prefill (hook H6).
 *
 * - Fails safe: if the mode cannot be read the build is treated as a development build.
 *
 * <module-headers:begin>
 * Uses:
 * src/lib/buildInfo.ts
 * ├── @yaran/secure-store:src/index.ts
 * └── src/lib/native/machineView.ts
 * External: none
 *
 * Used by:
 * src/lib/buildInfo.ts
 * ├── src/App.tsx
 * ├── src/a11y.test.tsx
 * ├── src/screens/onboarding/EnterUrl.tsx
 * ├── src/screens/onboarding/onboarding.test.tsx
 * ├── src/screens/screens.test.tsx
 * ├── src/screens/settings/Licenses.tsx
 * └── src/screens/settings/settings.test.tsx
 * <module-headers:end>
 */
import { BuildInfo, type Flavor } from '@yaran/secure-store';

import { Session, type CallbackMode } from './native/machineView.ts';

export interface ShellBuildInfo {
  callback: CallbackMode;
  flavor: Flavor;
  e2e: boolean;
  e2eControlPlaneUrl: string;
}

let pending: Promise<ShellBuildInfo> | null = null;

async function read(): Promise<ShellBuildInfo> {
  const callback = await Session.callbackMode().catch((): CallbackMode => ({ mode: 'dev' }));
  const info = await BuildInfo.get().catch(() => ({ flavor: 'foss' as const, e2e: false, e2eControlPlaneUrl: '' }));
  return { callback, ...info, e2eControlPlaneUrl: info.e2e ? info.e2eControlPlaneUrl : '' };
}

/** Reads the build facts once per page; later calls share the first answer. */
export function loadBuildInfo(): Promise<ShellBuildInfo> {
  pending ??= read();
  return pending;
}

/** Test hook: forget the cached answer. */
export function resetBuildInfoForTests(): void {
  pending = null;
}
