/**
 * Vitest setup for the shell: in-memory fakes of every native plugin.
 *
 * The shell has no browser build, so every test runs against these fakes: an in-memory
 * vault for `SecureStore`, scripted `AppLock`/`Diagnostics`/`ScreenPrivacy`/`BuildInfo`, and
 * `vi.fn()` doubles of Phase 15's `Session`/`MachineView` and `@capacitor/app`. Each test
 * starts from a clean vault and fresh mocks.
 *
 * - Activates the English catalog so rendered text is the real copy.
 *
 * <module-headers:begin>
 * Uses:
 * src/test/setup.ts
 * ├── @yaran/secure-store:src/index.ts
 * ├── src/lib/i18n.ts
 * └── src/lib/native/machineView.ts
 * External: @testing-library/react, vitest
 *
 * Used by:
 * src/test/setup.ts
 * ├── src/lib/orgStore.test.ts
 * └── src/lib/settingsStore.test.ts
 * <module-headers:end>
 */
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

import { activate } from '../lib/i18n.ts';

export const vault = new Map<string, string>();
const vaultKey = (ns: string, key: string) => `${ns}/${key}`;

vi.mock('@yaran/secure-store', async (importOriginal) => {
  const real = await importOriginal<typeof import('@yaran/secure-store')>();
  return {
    ...real,
    SecureStore: {
      get: vi.fn(async ({ namespace, key }: { namespace: string; key: string }) => ({ value: vault.get(vaultKey(namespace, key)) ?? null })),
      set: vi.fn(async ({ namespace, key, value }: { namespace: string; key: string; value: string }) => void vault.set(vaultKey(namespace, key), value)),
      remove: vi.fn(async ({ namespace, key }: { namespace: string; key: string }) => void vault.delete(vaultKey(namespace, key))),
      list: vi.fn(async ({ namespace }: { namespace: string }) => ({
        keys: [...vault.keys()].filter((k) => k.startsWith(`${namespace}/`)).map((k) => k.slice(namespace.length + 1)),
      })),
      eraseAll: vi.fn(async () => vault.clear()),
    },
    AppLock: {
      status: vi.fn(async () => ({ enabled: false, allowPasscode: false, grace: '1min', locked: false, biometry: 'available' })),
      enable: vi.fn(async () => ({ outcome: 'enabled' })),
      disable: vi.fn(async () => ({ outcome: 'disabled' })),
      unlock: vi.fn(async () => ({ outcome: 'unlocked' })),
      setOptions: vi.fn(async () => {}),
      addListener: vi.fn(async () => ({ remove: async () => {} })),
    },
    Diagnostics: {
      append: vi.fn(async () => {}),
      read: vi.fn(async () => ({ text: '2026-11-14T10:00:00Z info opened machines\n' })),
      export: vi.fn(async () => ({ outcome: 'shared' })),
    },
    ScreenPrivacy: { set: vi.fn(async () => {}), get: vi.fn(async () => ({ enabled: false })) },
    BuildInfo: { get: vi.fn(async () => ({ flavor: 'foss', e2e: false, e2eControlPlaneUrl: '' })) },
  };
});

vi.mock('../lib/native/machineView.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/native/machineView.ts')>();
  return {
    ...real,
    Session: {
      meta: vi.fn(),
      signIn: vi.fn(async () => ({ kind: 'signed_in' })),
      status: vi.fn(async () => ({ signedIn: true })),
      request: vi.fn(async () => ({ kind: 'offline' })),
      installId: vi.fn(async () => ({ installId: 'test-install' })),
      deviceKey: vi.fn(async () => ({ deviceKey: 'test-device-key' })),
      callbackMode: vi.fn(async () => ({ mode: 'https', domain: 'apps.example.org' })),
      signOut: vi.fn(async () => {}),
    },
    MachineView: {
      open: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      addListener: vi.fn(async () => ({ remove: async () => {} })),
      removeAllListeners: vi.fn(async () => {}),
    },
  };
});

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn(async () => ({ remove: async () => {} })),
    getLaunchUrl: vi.fn(async () => undefined),
    getInfo: vi.fn(async () => ({ name: 'yaran', id: 'com.example.yaran', build: '1000', version: '0.1.0' })),
  },
}));

activate('en');

// jsdom has no camera; the scanner screen gets a getUserMedia that never answers.
if (typeof navigator !== 'undefined' && !navigator.mediaDevices) {
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: () => new Promise(() => {}) } });
}

beforeEach(() => {
  vault.clear();
  if (typeof window !== 'undefined') window.location.hash = '';
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
