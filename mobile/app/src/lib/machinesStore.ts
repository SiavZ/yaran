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
 * ├── src/approvalNavigation.test.tsx
 * ├── src/continuations.test.tsx
 * ├── src/explicitOpen.test.tsx
 * ├── src/intakeBoundaries.test.tsx
 * ├── src/launch.test.tsx
 * ├── src/lib/deepLinks.test.ts
 * ├── src/lib/deepLinks.ts
 * ├── src/lib/directStore.test.ts
 * ├── src/lib/heldLinks.test.ts
 * ├── src/lib/knownHosts.ts
 * ├── src/lib/lifecycle.test.ts
 * ├── src/lib/lifecycle.ts
 * ├── src/lib/machinesStore.test.ts
 * ├── src/lib/openMachine.ts
 * ├── src/lib/orgStore.test.ts
 * ├── src/lib/orgStore.ts
 * ├── src/orgStaging.test.tsx
 * ├── src/orgStagingSettle.test.tsx
 * ├── src/push/pushRaces.test.ts
 * ├── src/push/pushRejections.test.ts
 * ├── src/push/pushToggles.test.ts
 * ├── src/push/pushTurns.test.ts
 * ├── src/push/pushWiring.test.ts
 * ├── src/push/pushWiring.ts
 * ├── src/reopenPriority.test.tsx
 * ├── src/screens/machines/MachineList.tsx
 * ├── src/screens/machines/MachineRoutes.tsx
 * ├── src/screens/machines/RemoveMachineDialog.tsx
 * ├── src/screens/machines/ShareTarget.tsx
 * ├── src/screens/machines/approval.test.tsx
 * ├── src/screens/machines/direct.test.tsx
 * ├── src/screens/machines/instanceChanged.test.tsx
 * ├── src/screens/machines/machines.test.tsx
 * ├── src/screens/machines/upgradeRequired.test.tsx
 * ├── src/screens/onboarding/ConfirmOrg.tsx
 * ├── src/screens/settings/NotificationSettings.tsx
 * └── src/shareBatch.test.tsx
 * <module-headers:end>
 */
import type { MachineSummary } from '@yaran/protocol';

import { listMachines, type ApiFailure, type ApiOutcome } from './api.ts';
import { createStore } from './store.ts';

export type OrgMachines =
  | { state: 'loading'; machines: MachineSummary[] }
  | { state: 'ready'; machines: MachineSummary[]; fetchedAt: number }
  | { state: 'failed'; machines: MachineSummary[]; failure: ApiFailure };

export const MACHINE_POLL_MS = 30_000;
export const machinesStore = createStore<Record<string, OrgMachines>>({});

interface Running {
  job: Promise<ApiFailure | null>;
  /** The org's incarnation this request belongs to (see `incarnationOf`). */
  incarnation: string;
  /** Machines dropped while this request was out: its answer predates their removal. */
  dropped: Set<string>;
  /** The refresh that starts after this one, asked for once a drop made this one stale. */
  next?: Promise<ApiFailure | null>;
}

const inFlight = new Map<string, Running>();
// An org removed and added again is a new incarnation: a request of the old one delivers
// nothing (no list, no failure, no follow-up), so its `device_revoked` can never remove the new one.
const incarnations = new Map<string, number>();
let era = 0;
let nextIncarnation = 1;
const incarnationOf = (orgId: string) => `${era}:${incarnations.get(orgId) ?? 0}`;

/**
 * Refreshes one org's list; resolves to the failure, or null on success. Coalesced per org,
 * except that a refresh asked for after a drop waits for a fresh request rather than joining
 * one that was sent before the drop.
 */
export function refreshMachines(orgId: string): Promise<ApiFailure | null> {
  const running = inFlight.get(orgId);
  if (running && running.incarnation === incarnationOf(orgId)) {
    if (running.dropped.size === 0) return running.job;
    running.next ??= running.job.then(() => (running.incarnation === incarnationOf(orgId) ? refreshMachines(orgId) : null));
    return running.next;
  }
  const previous = machinesStore.get()[orgId]?.machines ?? [];
  machinesStore.update((s) => ({ ...s, [orgId]: { state: 'loading', machines: previous } }));
  const self: Running = { job: Promise.resolve(null), incarnation: incarnationOf(orgId), dropped: new Set() };
  self.job = listMachines(orgId)
    .catch((): ApiOutcome<MachineSummary[]> => ({ ok: false, failure: { kind: 'native_error', code: 'unknown' } }))
    .then((got) => {
      // Cleared on every ending, so one failed refresh can never pin every later one to it.
      if (inFlight.get(orgId) === self) inFlight.delete(orgId);
      if (self.incarnation !== incarnationOf(orgId)) return null;
      const current = machinesStore.get()[orgId];
      if (!current) return null;
      // A failure keeps the list as it is now; a success drops what was removed while it was
      // out (only for this answer: a later fetch that lists the machine again shows it).
      const next: OrgMachines = got.ok
        ? { state: 'ready', machines: got.value.filter((m) => !self.dropped.has(m.id)), fetchedAt: Date.now() }
        : { state: 'failed', machines: current.machines, failure: got.failure };
      machinesStore.update((s) => ({ ...s, [orgId]: next }));
      return got.ok ? null : got.failure;
    });
  inFlight.set(orgId, self);
  return self.job;
}

/** Removes a machine from the cache right away (teardown started or already gone). */
export function dropMachine(orgId: string, machineId: string): void {
  inFlight.get(orgId)?.dropped.add(machineId);
  machinesStore.update((s) => {
    const cur = s[orgId];
    return cur ? { ...s, [orgId]: { ...cur, machines: cur.machines.filter((m) => m.id !== machineId) } } : s;
  });
}

export function machineHosts(orgId: string): string[] {
  return (machinesStore.get()[orgId]?.machines ?? []).map((m) => m.hostname);
}

export function forgetOrgMachines(orgId: string): void {
  inFlight.delete(orgId);
  incarnations.set(orgId, nextIncarnation++);
  machinesStore.update((s) => Object.fromEntries(Object.entries(s).filter(([k]) => k !== orgId)));
}

export function resetMachines(): void {
  inFlight.clear();
  era += 1;
  machinesStore.set({});
}
