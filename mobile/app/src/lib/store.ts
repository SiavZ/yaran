/**
 * A minimal observable value with a React hook, shared by the shell's stores.
 *
 * - Synchronous notification; readers use `useSyncExternalStore`, so a render never sees a
 *   torn value.
 *
 * <module-headers:begin>
 * Uses: none
 * External: react
 *
 * Used by:
 * src/lib/store.ts
 * ├── src/App.tsx
 * ├── src/lib/machinesStore.ts
 * ├── src/lib/orgStore.ts
 * ├── src/lib/settingsStore.ts
 * ├── src/push/pushDeps.ts
 * ├── src/screens/machines/MachineList.tsx
 * ├── src/screens/orgs/OrgList.tsx
 * ├── src/screens/settings/LanguageSettings.tsx
 * ├── src/screens/settings/NotificationSettings.tsx
 * └── src/screens/settings/Settings.tsx
 * <module-headers:end>
 */
import { useSyncExternalStore } from 'react';

export interface Store<T> {
  get(): T;
  set(next: T): void;
  update(fn: (prev: T) => T): void;
  subscribe(listener: () => void): () => void;
}

export function createStore<T>(initial: T): Store<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  const store: Store<T> = {
    get: () => value,
    set(next) {
      value = next;
      listeners.forEach((l) => l());
    },
    update: (fn) => store.set(fn(value)),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return store;
}

/** Reads a store in a component and re-renders on change. */
export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get);
}
