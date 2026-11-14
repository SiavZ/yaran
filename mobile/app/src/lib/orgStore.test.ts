/**
 * Tests for the org list: persistence, dedupe, sign-out, device revocation and erase.
 *
 * <module-headers:begin>
 * Uses:
 * src/lib/orgStore.test.ts
 * ├── @yaran/secure-store:src/index.ts
 * ├── src/lib/machinesStore.ts
 * ├── src/lib/native/machineView.ts
 * ├── src/lib/orgStore.ts
 * ├── src/lib/settingsStore.ts
 * └── src/test/setup.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test in mobile/app)
 * <module-headers:end>
 */
import { SecureStore } from '@yaran/secure-store';
import { beforeEach, describe, expect, it } from 'vitest';

import { machinesStore } from './machinesStore.ts';
import { Session } from './native/machineView.ts';
import { addOrg, eraseEverything, handleDeviceRevoked, loadOrgs, orgStore, signOutOrg } from './orgStore.ts';
import { settingsStore, updateSettings } from './settingsStore.ts';
import { vault } from '../test/setup.ts';

const ada = { id: 'https://cp.example.com', name: 'Ada Org', teamDomain: 'ada.example.com' };

beforeEach(() => orgStore.set({ loaded: false, orgs: [] }));

describe('orgStore', () => {
  it('persists added orgs in the standard class and reloads them', async () => {
    await addOrg(ada);
    expect(SecureStore.set).toHaveBeenCalledWith(expect.objectContaining({ namespace: 'orgs', key: 'list', protection: 'standard' }));
    orgStore.set({ loaded: false, orgs: [] });
    await loadOrgs();
    expect(orgStore.get().orgs.map((o) => o.id)).toEqual([ada.id]);
  });
  it('never lists the same org twice', async () => {
    await addOrg(ada);
    await addOrg({ ...ada, name: 'Renamed' });
    expect(orgStore.get().orgs).toHaveLength(1);
    expect(orgStore.get().orgs[0]!.name).toBe('Renamed');
  });
  it('drops malformed records and survives corrupt JSON', async () => {
    vault.set('orgs/list', JSON.stringify([{ id: 1 }, { ...ada, addedAt: 'x' }]));
    await loadOrgs();
    expect(orgStore.get().orgs).toHaveLength(1);
    vault.set('orgs/list', '{not json');
    await loadOrgs();
    expect(orgStore.get()).toEqual({ loaded: true, orgs: [] });
  });
  it('sign-out wipes native sessions for the org and its machines, then local data', async () => {
    await addOrg(ada);
    machinesStore.set({ [ada.id]: { state: 'ready', machines: [{ hostname: 'm1.example.com' } as never], fetchedAt: 0 } });
    await updateSettings({ lastMachine: { orgId: ada.id, machineId: 'm', host: 'm1.example.com' } });
    await signOutOrg(ada.id);
    expect(Session.signOut).toHaveBeenCalledWith({ orgId: ada.id, hosts: ['cp.example.com', 'm1.example.com'] });
    expect(orgStore.get().orgs).toEqual([]);
    expect(machinesStore.get()).toEqual({});
    expect(settingsStore.get().lastMachine).toBeNull();
  });
  it('device_revoked removes the org without calling sign-out', async () => {
    await addOrg(ada);
    await handleDeviceRevoked(ada.id);
    expect(Session.signOut).not.toHaveBeenCalled();
    expect(orgStore.get().orgs).toEqual([]);
  });
  it('erase signs out of every org, even when one fails, then wipes the vault', async () => {
    await addOrg(ada);
    await addOrg({ ...ada, id: 'https://cp2.example.com' });
    (Session.signOut as unknown as { mockRejectedValueOnce(e: unknown): void }).mockRejectedValueOnce(new Error('offline'));
    await eraseEverything();
    expect(Session.signOut).toHaveBeenCalledTimes(2);
    expect(SecureStore.eraseAll).toHaveBeenCalled();
    expect(orgStore.get().orgs).toEqual([]);
    expect(vault.size).toBe(0);
  });
});
