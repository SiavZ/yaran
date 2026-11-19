/**
 * The org list: the orgs this phone has added, kept in the vault's `orgs` namespace.
 *
 * An org record holds only what the user confirmed on Confirm org (its canonical URL, which
 * is also its id, its display name and Access team domain). Signing out, a `device_revoked`
 * answer and "Erase everything" all remove the org's local data here, including any direct
 * machine route through the org; the native session wipe belongs to `Session.signOut`.
 * "Erase everything" also ends every direct machine's session through `Session.directSignOut`.
 *
 * - The list lives in the `standard` protection class, so it survives an app-lock key
 *   invalidation (only sessions are wiped then).
 * - Org-supplied text (the name) is data, rendered as React text only.
 * - Seam (Phase 16): push unregistration for a removed org belongs in `signOutOrg` and
 *   `eraseEverything`, before `Session.signOut`; `handleDeviceRevoked` needs none (the
 *   device row is already gone).
 *
 * <module-headers:begin>
 * Uses:
 * src/lib/orgStore.ts
 * ├── @yaran/secure-store:src/index.ts
 * ├── src/lib/diagnostics.ts
 * ├── src/lib/directStore.ts
 * ├── src/lib/erasure.ts
 * ├── src/lib/machinesStore.ts
 * ├── src/lib/native/machineView.ts
 * ├── src/lib/settingsStore.ts
 * ├── src/lib/store.ts
 * └── src/push/pushDeps.ts
 * External: none
 *
 * Used by:
 * src/lib/orgStore.ts
 * ├── src/App.tsx
 * ├── src/a11y.test.tsx
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
 * ├── src/lib/openMachine.ts
 * ├── src/lib/orgStore.test.ts
 * ├── src/lib/settingsStore.test.ts
 * ├── src/main.tsx
 * ├── src/modalNavigation.test.tsx
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
 * ├── src/screens/onboarding/EnterUrl.tsx
 * ├── src/screens/onboarding/onboarding.test.tsx
 * ├── src/screens/orgs/OrgList.tsx
 * ├── src/screens/orgs/SignOutOrgDialog.tsx
 * ├── src/screens/screens.test.tsx
 * ├── src/screens/settings/EraseDialog.tsx
 * ├── src/screens/settings/NotificationSettings.tsx
 * ├── src/screens/settings/notificationPreferences.test.tsx
 * ├── src/screens/settings/settings.test.tsx
 * └── src/shareBatch.test.tsx
 * <module-headers:end>
 */
import { SecureStore } from '@yaran/secure-store';

import { muteSync, unregisterOrgPush } from '../push/pushDeps.ts';
import { log } from './diagnostics.ts';
import { CatalogRefusal, drainDirect, forgetOrgRoutes, resetDirect, signOutAllDirect } from './directStore.ts';
import { eraseEpoch, erasing, runErase } from './erasure.ts';
import { forgetOrgMachines, machineHosts, resetMachines } from './machinesStore.ts';
import { Session } from './native/machineView.ts';
import { drainSettings, forgetLastMachineOf, resetSettings } from './settingsStore.ts';
import { createStore } from './store.ts';

export interface OrgRecord {
  /** The canonical 02 OrgUrl; also the `orgId` every native call takes. */
  id: string;
  name: string;
  teamDomain: string | null;
  addedAt: string;
}

export interface OrgState {
  loaded: boolean;
  orgs: OrgRecord[];
}

const NS = { namespace: 'orgs', key: 'list' } as const;
export const orgStore = createStore<OrgState>({ loaded: false, orgs: [] });

function isOrgRecord(v: unknown): v is OrgRecord {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    typeof r.name === 'string' &&
    (r.teamDomain === null || typeof r.teamDomain === 'string') &&
    typeof r.addedAt === 'string'
  );
}

/** Reads the list once at start; a corrupt list is dropped loudly rather than half-read. */
export async function loadOrgs(): Promise<void> {
  let orgs: OrgRecord[] = [];
  try {
    const { value } = await SecureStore.get(NS);
    const parsed: unknown = value === null ? [] : JSON.parse(value);
    orgs = Array.isArray(parsed) ? parsed.filter(isOrgRecord) : [];
    if (Array.isArray(parsed) && orgs.length !== parsed.length) log('warn', 'dropped malformed org records from the vault');
  } catch (err) {
    log('error', `could not read the org list: ${err instanceof Error ? err.message : String(err)}`);
  }
  orgStore.set({ loaded: true, orgs });
}

// One org-list write at a time, computed from the list when its turn comes.
let queue: Promise<unknown> = Promise.resolve();
// Each time an org appears on this phone it is a new incarnation: work that captured an older
// one (a refresh, a push answer, a sign-in rollback) must not remove or restore the new one.
const incarnations = new Map<string, number>();
let nextIncarnation = 1;
// Confirm org sign-ins not settled yet, per org. The newest staging owns the entry; `previous` is
// what was durably there before any of them (undefined: nothing), which only the owner's failure
// puts back. Bound to the write that staged it, so an older attempt's late answer can neither
// remove nor overwrite what a newer one staged. Gone with the org, and cleared by an erase.
const stagings = new Map<string, { token: number; previous: OrgRecord | undefined }>();
let nextStaging = 0;

/** The current incarnation of `id`, or undefined when it is not on this phone. */
export function orgIncarnation(id: string): number | undefined {
  if (!orgStore.get().orgs.some((o) => o.id === id)) {
    incarnations.delete(id);
    return undefined;
  }
  let inc = incarnations.get(id);
  if (inc === undefined) incarnations.set(id, (inc = nextIncarnation++));
  return inc;
}

/**
 * Writes the list `change` makes of the current one (null: nothing to do), in turn. Refused
 * during an erase, and when one started after `asOf`; erase drains this queue before its wipe.
 *
 * `read` names what `change` decided from outside the list (a staging's fallback). If it moves
 * while the list is being stored, the list is decided again from the same base and stored again
 * in this same turn, before anything is published. When that second store fails, what the vault
 * holds is published (memory never differs from it) and the write throws `fallback_unsaved`.
 */
function write(
  change: (orgs: OrgRecord[]) => OrgRecord[] | null,
  asOf = eraseEpoch(),
  committed: () => void = () => undefined,
  read?: () => unknown,
): Promise<boolean> {
  if (erasing()) return Promise.reject(new CatalogRefusal('erased'));
  const run = queue.then(async () => {
    if (asOf !== eraseEpoch()) throw new CatalogRefusal('erased');
    const base = orgStore.get().orgs;
    let seen = read?.();
    let orgs = change(base);
    if (orgs === null) return false;
    await SecureStore.set({ ...NS, value: JSON.stringify(orgs), protection: 'standard' });
    if (asOf !== eraseEpoch()) throw new CatalogRefusal('erased');
    const publish = (list: OrgRecord[]) => {
      for (const id of incarnations.keys()) if (!list.some((o) => o.id === id)) incarnations.delete(id);
      for (const id of stagings.keys()) if (!list.some((o) => o.id === id)) stagings.delete(id);
      committed();
      orgStore.set({ loaded: true, orgs: list });
    };
    while (read && read() !== seen) {
      seen = read();
      const next = change(base) ?? base;
      try {
        await SecureStore.set({ ...NS, value: JSON.stringify(next), protection: 'standard' });
      } catch (err) {
        log('error', `could not store a settled org fallback: ${err instanceof Error ? err.message : String(err)}`);
        if (asOf !== eraseEpoch()) throw new CatalogRefusal('erased');
        publish(orgs);
        throw new CatalogRefusal('fallback_unsaved');
      }
      if (asOf !== eraseEpoch()) throw new CatalogRefusal('erased');
      orgs = next;
    }
    publish(orgs);
    return true;
  });
  queue = run.catch(() => undefined);
  return run;
}

export function findOrg(id: string): OrgRecord | undefined {
  return orgStore.get().orgs.find((o) => o.id === id);
}

/** Adds or refreshes an org after Confirm org; the same URL never appears twice. `asOf` fences it against an erase. */
export async function addOrg(org: Omit<OrgRecord, 'addedAt'>, asOf = eraseEpoch()): Promise<void> {
  await write((orgs) => {
    const existing = orgs.find((o) => o.id === org.id);
    return [...orgs.filter((o) => o.id !== org.id), { ...org, addedAt: existing?.addedAt ?? new Date().toISOString() }];
  }, asOf);
}

/** One Confirm org sign-in's staging: its token, and the record it wrote. */
export interface Staging {
  token: number;
  record: OrgRecord;
}

/**
 * Adds or refreshes an org for a sign-in about to start, and makes that sign-in the entry's owner
 * in the same write turn. A staging over one still unsettled keeps that one's durable `previous`.
 */
export async function stageOrg(org: Omit<OrgRecord, 'addedAt'>, asOf = eraseEpoch()): Promise<Staging> {
  const token = ++nextStaging;
  let record!: OrgRecord;
  let before: OrgRecord | undefined;
  await write(
    (orgs) => {
      before = orgs.find((o) => o.id === org.id);
      record = { ...org, addedAt: before?.addedAt ?? new Date().toISOString() };
      return [...orgs.filter((o) => o.id !== org.id), record];
    },
    asOf,
    () => {
      const unsettled = stagings.get(org.id);
      stagings.set(org.id, { token, previous: unsettled ? unsettled.previous : before });
    },
  );
  return { token, record };
}

/** Whether staging `token` still owns the org's entry (no newer staging, not removed since). */
export function ownsStaging(id: string, token: number): boolean {
  return stagings.get(id)?.token === token;
}

/**
 * The sign-in of `staging` succeeded: its record is durable now. As the owner it settles the
 * entry; under a newer staging still out, it becomes what that one falls back to.
 */
export function settleStaging(id: string, staging: Staging): void {
  const owner = stagings.get(id);
  if (owner === undefined) return;
  if (owner.token === staging.token) stagings.delete(id);
  else owner.previous = staging.record;
}

/**
 * The sign-in of staging `token` did not succeed: only while it still owns the entry, the durable
 * record before it is put back, or the org forgotten when there was none. Decided in the write
 * queue. Resolves whether it changed anything.
 */
export async function unstageOrg(id: string, token: number, asOf = eraseEpoch()): Promise<boolean> {
  if (!ownsStaging(id, token)) return false;
  const inc = orgIncarnation(id);
  const owns = () => ownsStaging(id, token) && orgIncarnation(id) === inc;
  // The fallback is read in the write's turn; an older sign-in settling while the list is stored
  // moves it, and the write then stores what is true now before publishing anything (see `write`).
  const fallback = () => stagings.get(id)?.previous;
  // Nothing durable before it: what the shell keeps about the org goes first, as `removeOrgLocal`
  // does, step by step while this staging still owns the entry. A newer staging committing
  // meanwhile owns it, and this one stops having touched nothing of the list.
  if (fallback() === undefined) {
    forgetOrgMachines(id);
    await forgetLastMachineOf(id);
    if (!owns()) return false;
    await forgetOrgRoutes(id);
    if (!owns()) return false;
  }
  const changed = await write(
    (orgs) => {
      if (!owns()) return null;
      const previous = fallback();
      return previous ? [...orgs.filter((o) => o.id !== id), previous] : orgs.filter((o) => o.id !== id);
    },
    asOf,
    () => stagings.delete(id),
    fallback,
  );
  if (changed && !findOrg(id)) muteSync.forget(id);
  return changed;
}

/**
 * Puts `previous` back for incarnation `inc` of its org (a re-sign-in that did not succeed):
 * decided inside the write queue, so it never restores an org signed out meanwhile, nor
 * overwrites one removed and added again. Resolves whether it restored.
 */
export function restoreOrg(previous: OrgRecord, inc: number | undefined, asOf = eraseEpoch()): Promise<boolean> {
  return write((orgs) => {
    if (inc === undefined || orgIncarnation(previous.id) !== inc) return null;
    return [...orgs.filter((o) => o.id !== previous.id), previous];
  }, asOf);
}

/**
 * Forgets everything this shell keeps about incarnation `inc` of an org (list entry, machine
 * cache, last machine, direct routes through it). Checked before every step and again inside
 * the list write, so a stale caller never touches an org removed and added again meanwhile.
 * Resolves whether it removed it.
 */
export async function removeOrgLocal(id: string, inc = orgIncarnation(id)): Promise<boolean> {
  const current = () => inc !== undefined && orgIncarnation(id) === inc;
  if (!current()) return false;
  forgetOrgMachines(id);
  await forgetLastMachineOf(id);
  if (!current()) return false;
  await forgetOrgRoutes(id);
  if (!current()) return false;
  const removed = await write((orgs) => (current() ? orgs.filter((o) => o.id !== id) : null));
  if (removed) muteSync.forget(id);
  return removed;
}

/** Sign out: Phase 15 deletes sessions, cookies, install id and device key; then local data. */
export async function signOutOrg(id: string): Promise<void> {
  const inc = orgIncarnation(id);
  // W14 needs the org session, so the device row goes before the sign-out deletes it. It stops
  // as soon as this org is no longer incarnation `inc`, so it never unregisters a re-added one.
  await unregisterOrgPush(id, () => inc !== undefined && orgIncarnation(id) === inc && !erasing());
  // Removed (or erased and added again) meanwhile: the native sessions are not this sign-out's to end.
  if (inc === undefined || orgIncarnation(id) !== inc) return;
  await Session.signOut({ orgId: id, hosts: [new URL(id).hostname, ...machineHosts(id)] });
  await removeOrgLocal(id, inc);
}

/** The native client already wiped incarnation `inc`'s sessions; drop its local data. Resolves whether it did. */
export function handleDeviceRevoked(id: string, inc = orgIncarnation(id)): Promise<boolean> {
  log('warn', 'org answered device_revoked; removing it from this phone');
  return removeOrgLocal(id, inc);
}

/**
 * Erase everything: one barrier over org and direct storage and sign-in (see `erasure.ts`). It
 * waits for every queued or running org and direct write and same-host sign-in, signs out of
 * every org and direct machine (best effort), erases the vault and its keys, then forgets it all
 * in memory. A second Erase while one runs joins it.
 */
export function eraseEverything(): Promise<void> {
  return runErase(async () => {
    await drainDirect();
    await queue;
    await drainSettings();
    for (const org of orgStore.get().orgs) {
      await unregisterOrgPush(org.id);
      await Session.signOut({ orgId: org.id, hosts: [new URL(org.id).hostname, ...machineHosts(org.id)] }).catch(() =>
        log('warn', 'sign-out failed during erase; the vault wipe still removes its sessions'),
      );
    }
    await signOutAllDirect();
    await SecureStore.eraseAll();
    resetMachines();
    resetSettings();
    resetDirect();
    muteSync.forget();
    incarnations.clear();
    stagings.clear();
    orgStore.set({ loaded: true, orgs: [] });
  });
}
