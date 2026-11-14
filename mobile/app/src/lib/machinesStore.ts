/**
 * Machine lists per org: a cache, a refresh, and the state each list is in.
 *
 * Refreshes run on screen entry, on resume, on pull-to-refresh and every 30 s of visible
 * time while the Machines screen is shown (the screen owns the clock). A `device_revoked`
 * answer is handed back to the caller, which removes the org.
 *
 * - Memory only: machine lists are not persisted; they are cheap to fetch and go stale.
 *
 * <module-headers:begin>
 * Uses:
 * src/lib/machinesStore.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/lib/api.ts
 * └── src/lib/store.ts
 * External: none
 *
 * Used by:
 * src/lib/machinesStore.ts
 * ├── src/lib/lifecycle.test.ts
 * ├── src/lib/lifecycle.ts
 * ├── src/lib/machinesStore.test.ts
 * ├── src/lib/openMachine.ts
 * ├── src/lib/orgStore.test.ts
 * ├── src/lib/orgStore.ts
 * ├── src/screens/machines/MachineList.tsx
 * ├── src/screens/machines/RemoveMachineDialog.tsx
 * ├── src/screens/machines/machines.test.tsx
 * └── src/screens/onboarding/ConfirmOrg.tsx
 * <module-headers:end>
 */
import type { MachineSummary } from '@yaran/protocol';

import { listMachines, type ApiFailure } from './api.ts';
import { createStore } from './store.ts';

export type OrgMachines =
  | { state: 'loading'; machines: MachineSummary[] }
  | { state: 'ready'; machines: MachineSummary[]; fetchedAt: number }
  | { state: 'failed'; machines: MachineSummary[]; failure: ApiFailure };

export const MACHINE_POLL_MS = 30_000;
export const machinesStore = createStore<Record<string, OrgMachines>>({});

const inFlight = new Map<string, Promise<ApiFailure | null>>();

/** Refreshes one org's list; resolves to the failure, or null on success. Coalesced per org. */
export function refreshMachines(orgId: string): Promise<ApiFailure | null> {
  const running = inFlight.get(orgId);
  if (running) return running;
  const previous = machinesStore.get()[orgId]?.machines ?? [];
  machinesStore.update((s) => ({ ...s, [orgId]: { state: 'loading', machines: previous } }));
  const job = listMachines(orgId).then((got) => {
    inFlight.delete(orgId);
    if (!(orgId in machinesStore.get())) return got.ok ? null : got.failure;
    const next: OrgMachines = got.ok
      ? { state: 'ready', machines: got.value, fetchedAt: Date.now() }
      : { state: 'failed', machines: previous, failure: got.failure };
    machinesStore.update((s) => ({ ...s, [orgId]: next }));
    return got.ok ? null : got.failure;
  });
  inFlight.set(orgId, job);
  return job;
}

/** Removes a machine from the cache right away (teardown started or already gone). */
export function dropMachine(orgId: string, machineId: string): void {
  machinesStore.update((s) => {
    const cur = s[orgId];
    return cur ? { ...s, [orgId]: { ...cur, machines: cur.machines.filter((m) => m.id !== machineId) } } : s;
  });
}

export function machineHosts(orgId: string): string[] {
  return (machinesStore.get()[orgId]?.machines ?? []).map((m) => m.hostname);
}

export function forgetOrgMachines(orgId: string): void {
  machinesStore.update((s) => Object.fromEntries(Object.entries(s).filter(([k]) => k !== orgId)));
}

export function resetMachines(): void {
  machinesStore.set({});
}
