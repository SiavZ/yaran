/**
 * The TypeScript contract of the secure-store plugin: the device-local security base the
 * shell reaches through the Capacitor bridge.
 *
 * Five plugin objects share one native core (`mobile/plugins/core`): `SecureStore` (the
 * vault, namespaced string values), `AppLock` (the optional biometric lock), `Diagnostics`
 * (the sanitized local log), `ScreenPrivacy` (FLAG_SECURE / app-switcher cover) and
 * `BuildInfo` (the compiled flavor and e2e defaults the bundled shell cannot know). The
 * native adapters validate every argument and reject with one of `SecureStoreErrorCode`.
 *
 * - Trust boundary: the shell is the only bridge-enabled page (D9). No method returns a
 *   credential: the `session`, `handoff`, `install` and `push` namespaces belong to native
 *   code (Phases 15 and 16) and every call naming them is refused with `reserved_namespace`.
 * - Values are UTF-8 strings; callers store JSON text they own.
 * - Plugin registration seam for sibling plugins (Phases 15, 16): a plugin package exports
 *   its `registerPlugin` objects from `src/index.ts` and its definitions from here, exactly
 *   like this one; the shell imports only the package root.
 *
 * <module-headers:begin>
 * Uses: none
 * External: @capacitor/core
 *
 * Used by:
 * src/definitions.ts
 * ├── src/index.ts
 * ├── src/web.ts
 * └── test/contract.test.ts
 * <module-headers:end>
 */
import type { PluginListenerHandle } from '@capacitor/core';

/** Stable rejection codes every native adapter maps core errors onto. */
export const SECURE_STORE_ERROR_CODES = [
  'invalid_argument',
  'reserved_namespace',
  'tampered',
  'invalidated',
  'locked',
  'unavailable',
] as const;
export type SecureStoreErrorCode = (typeof SECURE_STORE_ERROR_CODES)[number];

/** Namespaces only native code may touch (prefix match on the namespace name). */
export const RESERVED_NAMESPACES = ['session', 'handoff', 'install', 'push'] as const;

/** `standard`: device-bound, no user auth. `locked`: wrapped by the app-lock key. */
export type Protection = 'standard' | 'locked';

/** Namespace `[a-z0-9-]{1,32}`, key `[A-Za-z0-9._-]{1,64}`, checked natively as well. */
export const NAMESPACE_RE = /^[a-z0-9-]{1,32}$/;
export const KEY_RE = /^[A-Za-z0-9._-]{1,64}$/;

export interface SecureStorePlugin {
  get(options: { namespace: string; key: string }): Promise<{ value: string | null }>;
  set(options: { namespace: string; key: string; value: string; protection?: Protection }): Promise<void>;
  remove(options: { namespace: string; key: string }): Promise<void>;
  list(options: { namespace: string }): Promise<{ keys: string[] }>;
  /** "Erase everything on this phone": every namespace (native ones included) and the vault keys. */
  eraseAll(): Promise<void>;
}

/** How long the app may sit in the background before the lock engages again. */
export const LOCK_GRACES = ['immediately', '1min', '5min', '15min'] as const;
export type LockGrace = (typeof LOCK_GRACES)[number];
export const DEFAULT_LOCK_GRACE: LockGrace = '1min';

export type Biometry = 'available' | 'none_enrolled' | 'unavailable';

export interface AppLockStatus {
  enabled: boolean;
  allowPasscode: boolean;
  grace: LockGrace;
  /** True while the native cover hides the shell (and machine-view) until unlock. */
  locked: boolean;
  biometry: Biometry;
}

export interface AppLockPlugin {
  status(): Promise<AppLockStatus>;
  /** Creates the lock key and prompts once to prove the user can unlock. */
  enable(options: { allowPasscode: boolean }): Promise<{ outcome: 'enabled' | 'cancelled' | 'unavailable' }>;
  /** Prompts, then re-wraps the `locked` class under the standard key and deletes the lock key. */
  disable(): Promise<{ outcome: 'disabled' | 'cancelled' }>;
  /** `invalidated`: biometrics changed, the `locked` class (sessions) was wiped. */
  unlock(): Promise<{ outcome: 'unlocked' | 'cancelled' | 'invalidated' }>;
  setOptions(options: { grace?: LockGrace; allowPasscode?: boolean }): Promise<void>;
  addListener(
    eventName: 'lockStateChanged',
    listener: (event: { locked: boolean }) => void,
  ): Promise<PluginListenerHandle>;
}

export type DiagnosticsLevel = 'info' | 'warn' | 'error';

export interface DiagnosticsPlugin {
  /** Every entry passes the native sanitizer before it is kept. */
  append(options: { level: DiagnosticsLevel; message: string }): Promise<void>;
  /** The sanitized log text, for the in-shell preview shown before export. */
  read(): Promise<{ text: string }>;
  /** Opens the native share sheet with the log file. */
  export(): Promise<{ outcome: 'shared' | 'cancelled' }>;
}

export interface ScreenPrivacyPlugin {
  /** Persisted natively, so the next launch applies it before the shell loads. */
  set(options: { enabled: boolean }): Promise<void>;
  get(): Promise<{ enabled: boolean }>;
}

/** Store channel the binary was built for; one web bundle serves every flavor. */
export type Flavor = 'foss' | 'play' | 'appstore';

export interface BuildInfoPlugin {
  /**
   * Compiled build facts. `e2e` is true only in the Android `e2e` build type and the iOS
   * `E2E` configuration; `e2eControlPlaneUrl` is empty everywhere else (Phase 19 hook H6).
   */
  get(): Promise<{ flavor: Flavor; e2e: boolean; e2eControlPlaneUrl: string }>;
}
