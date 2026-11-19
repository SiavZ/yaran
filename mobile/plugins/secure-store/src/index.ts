/**
 * Package entry of `@yaran/secure-store`: registers the five bridge objects.
 *
 * `registerPlugin` binds each name to the native class of the same `jsName` on Android and
 * iOS; the web fallback exists only so Vitest mocks have something to replace.
 *
 * - The shell imports only this root; deep imports are not part of the contract.
 *
 * <module-headers:begin>
 * Uses:
 * src/index.ts
 * ├── src/definitions.ts
 * └── src/web.ts
 * External: @capacitor/core
 *
 * Used by:
 * src/index.ts
 * ├── @yaran/mobile-shell:src/App.tsx
 * ├── @yaran/mobile-shell:src/approvalNavigation.test.tsx
 * ├── @yaran/mobile-shell:src/continuations.test.tsx
 * ├── @yaran/mobile-shell:src/explicitOpen.test.tsx
 * ├── @yaran/mobile-shell:src/launch.test.tsx
 * ├── @yaran/mobile-shell:src/lib/buildInfo.ts
 * ├── @yaran/mobile-shell:src/lib/deepLinks.test.ts
 * ├── @yaran/mobile-shell:src/lib/deepLinks.ts
 * ├── @yaran/mobile-shell:src/lib/diagnostics.test.ts
 * ├── @yaran/mobile-shell:src/lib/diagnostics.ts
 * ├── @yaran/mobile-shell:src/lib/directStore.test.ts
 * ├── @yaran/mobile-shell:src/lib/directStore.ts
 * ├── @yaran/mobile-shell:src/lib/heldLinks.test.ts
 * ├── @yaran/mobile-shell:src/lib/lifecycle.ts
 * ├── @yaran/mobile-shell:src/lib/orgStore.test.ts
 * ├── @yaran/mobile-shell:src/lib/orgStore.ts
 * ├── @yaran/mobile-shell:src/lib/settingsStore.test.ts
 * ├── @yaran/mobile-shell:src/lib/settingsStore.ts
 * ├── @yaran/mobile-shell:src/modalNavigation.test.tsx
 * ├── @yaran/mobile-shell:src/orgStaging.test.tsx
 * ├── @yaran/mobile-shell:src/orgStagingSettle.test.tsx
 * ├── @yaran/mobile-shell:src/push/pushRaces.test.ts
 * ├── @yaran/mobile-shell:src/push/pushTurns.test.ts
 * ├── @yaran/mobile-shell:src/push/pushWiring.test.ts
 * ├── @yaran/mobile-shell:src/reopenPriority.test.tsx
 * ├── @yaran/mobile-shell:src/screens/machines/approval.test.tsx
 * ├── @yaran/mobile-shell:src/screens/machines/direct.test.tsx
 * ├── @yaran/mobile-shell:src/screens/machines/instanceChanged.test.tsx
 * ├── @yaran/mobile-shell:src/screens/machines/machines.test.tsx
 * ├── @yaran/mobile-shell:src/screens/onboarding/onboarding.test.tsx
 * ├── @yaran/mobile-shell:src/screens/screens.test.tsx
 * ├── @yaran/mobile-shell:src/screens/settings/Diagnostics.tsx
 * ├── @yaran/mobile-shell:src/screens/settings/Licenses.tsx
 * ├── @yaran/mobile-shell:src/screens/settings/LockScreen.tsx
 * ├── @yaran/mobile-shell:src/screens/settings/SecuritySettings.tsx
 * ├── @yaran/mobile-shell:src/screens/settings/settings.test.tsx
 * ├── @yaran/mobile-shell:src/shareBatch.test.tsx
 * └── @yaran/mobile-shell:src/test/setup.ts
 * <module-headers:end>
 */
import { registerPlugin } from '@capacitor/core';

import type {
  AppLockPlugin,
  BuildInfoPlugin,
  DiagnosticsPlugin,
  ScreenPrivacyPlugin,
  SecureStorePlugin,
} from './definitions.ts';
import { unavailable } from './web.ts';

export * from './definitions.ts';

export const SecureStore = registerPlugin<SecureStorePlugin>('SecureStore', { web: unavailable });
export const AppLock = registerPlugin<AppLockPlugin>('AppLock', { web: unavailable });
export const Diagnostics = registerPlugin<DiagnosticsPlugin>('Diagnostics', { web: unavailable });
export const ScreenPrivacy = registerPlugin<ScreenPrivacyPlugin>('ScreenPrivacy', { web: unavailable });
export const BuildInfo = registerPlugin<BuildInfoPlugin>('BuildInfo', { web: unavailable });
