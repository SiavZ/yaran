/**
 * The org list: the orgs this phone has added, kept in the vault's `orgs` namespace.
 *
 * An org record holds only what the user confirmed on Confirm org (its canonical URL, which
 * is also its id, its display name and Access team domain). Signing out, a `device_revoked`
 * answer and "Erase everything" all remove the org's local data here; the native session
 * wipe belongs to Phase 15's `Session.signOut`.
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
 * ├── src/lib/machinesStore.ts
 * ├── src/lib/native/machineView.ts
 * ├── src/lib/settingsStore.ts
 * └── src/lib/store.ts
 * External: none
 *
 * Used by:
 * src/lib/orgStore.ts
 * ├── src/App.tsx
 * ├── src/a11y.test.tsx
 * ├── src/lib/lifecycle.test.ts
 * ├── src/lib/lifecycle.ts
 * ├── src/lib/orgStore.test.ts
 * ├── src/main.tsx
 * ├── src/screens/machines/MachineList.tsx
 * ├── src/screens/machines/machines.test.tsx
 * ├── src/screens/onboarding/ConfirmOrg.tsx
 * ├── src/screens/onboarding/onboarding.test.tsx
 * ├── src/screens/orgs/OrgList.tsx
 * ├── src/screens/orgs/SignOutOrgDialog.tsx
 * ├── src/screens/screens.test.tsx
 * ├── src/screens/settings/EraseDialog.tsx
 * └── src/screens/settings/settings.test.tsx
 * <module-headers:end>
 */
import { SecureStore } from '@yaran/secure-store';

import { log } from './diagnostics.ts';
import { forgetOrgMachines, machineHosts, resetMachines } from './machinesStore.ts';
import { Session } from './native/machineView.ts';
import { forgetLastMachineOf, resetSettings } from './settingsStore.ts';
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

async function save(orgs: OrgRecord[]): Promise<void> {
  await SecureStore.set({ ...NS, value: JSON.stringify(orgs), protection: 'standard' });
  orgStore.set({ loaded: true, orgs });
}

export function findOrg(id: string): OrgRecord | undefined {
  return orgStore.get().orgs.find((o) => o.id === id);
}

/** Adds or refreshes an org after Confirm org; the same URL never appears twice. */
export async function addOrg(org: Omit<OrgRecord, 'addedAt'>): Promise<void> {
  const others = orgStore.get().orgs.filter((o) => o.id !== org.id);
  const existing = findOrg(org.id);
  await save([...others, { ...org, addedAt: existing?.addedAt ?? new Date().toISOString() }]);
}

/** Forgets everything this shell keeps about an org (list entry, machine cache, last machine). */
export async function removeOrgLocal(id: string): Promise<void> {
  forgetOrgMachines(id);
  await forgetLastMachineOf(id);
  await save(orgStore.get().orgs.filter((o) => o.id !== id));
}

/** Sign out: Phase 15 deletes sessions, cookies, install id and device key; then local data. */
export async function signOutOrg(id: string): Promise<void> {
  await Session.signOut({ orgId: id, hosts: [new URL(id).hostname, ...machineHosts(id)] });
  await removeOrgLocal(id);
}

/** The native client already wiped the org's sessions; drop its local data too. */
export async function handleDeviceRevoked(id: string): Promise<void> {
  log('warn', 'org answered device_revoked; removing it from this phone');
  await removeOrgLocal(id);
}

/** Signs out of every org (best effort), then erases the vault and its keys. */
export async function eraseEverything(): Promise<void> {
  for (const org of orgStore.get().orgs) {
    await Session.signOut({ orgId: org.id, hosts: [new URL(org.id).hostname, ...machineHosts(org.id)] }).catch(() =>
      log('warn', 'sign-out failed during erase; the vault wipe still removes its sessions'),
    );
  }
  await SecureStore.eraseAll();
  resetMachines();
  resetSettings();
  orgStore.set({ loaded: true, orgs: [] });
}
