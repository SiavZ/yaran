/**
 * Tests for direct machines: metadata-only persistence, the known-host guard, Remove's native
 * sign-out ordering and failure handling, org sign-out dropping org routes, and Erase
 * everything ending direct sessions before the vault wipe.
 *
 * <module-headers:begin>
 * Uses:
 * src/lib/directStore.test.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── @yaran/secure-store:src/index.ts
 * ├── src/lib/directStore.ts
 * ├── src/lib/knownHosts.ts
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
import type { MachineSummary } from '@yaran/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { vault } from '../test/setup.ts';
import { addDirect, CatalogRefusal, directStore, findDirectByHost, forgetOrgRoutes, loadDirect, removeDirect, updateDirect, withHost, type DirectRecord } from './directStore.ts';
import { hostOwner, orgRouteTaken } from './knownHosts.ts';
import { machinesStore, resetMachines } from './machinesStore.ts';
import { Session } from './native/machineView.ts';
import { eraseEverything, orgStore, signOutOrg } from './orgStore.ts';
import { settingsStore, DEFAULT_SETTINGS } from './settingsStore.ts';

const ORG = { id: 'https://cp.example.com', name: 'Ada Org', teamDomain: null, addedAt: 'x' };
const MACHINE = { id: '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b', name: 'laptop', hostname: 'laptop-ada.example.com' } as MachineSummary;

beforeEach(() => {
  vi.mocked(Session.directSignOut).mockReset().mockResolvedValue({ kind: 'signed_out', serverEnded: true });
  resetMachines();
  orgStore.set({ loaded: true, orgs: [] });
  settingsStore.set(DEFAULT_SETTINGS);
});

describe('direct machine records', () => {
  it('stores metadata only: no password, token or cookie ever reaches the vault list', async () => {
    const r = await addDirect({ host: 'box.tail1.ts.net', instance: 'inst-1' });
    const stored = JSON.parse(vault.get('direct/list')!) as unknown[];
    expect(stored).toEqual([{ id: r.id, label: 'box.tail1.ts.net', host: 'box.tail1.ts.net', instance: 'inst-1', addedAt: r.addedAt, routes: [{ kind: 'direct', host: 'box.tail1.ts.net' }] }]);
    expect(vi.mocked(SecureStore.set).mock.calls.every((c) => c[0].namespace === 'direct' || c[0].namespace === 'settings')).toBe(true);
  });

  it('drops malformed records loudly and keeps the good ones', async () => {
    const good = { id: 'a', label: 'a', host: 'a.example.com', instance: null, addedAt: 'x', routes: [{ kind: 'direct', host: 'a.example.com' }] };
    vault.set(
      'direct/list',
      JSON.stringify([
        good,
        { ...good, id: 'b', host: 'B.example.com', routes: [{ kind: 'direct', host: 'B.example.com' }] },
        { ...good, id: 'c', host: 'c.example.com', routes: [{ kind: 'direct', host: 'other.example.com' }] },
        { ...good, id: 'd', host: '10.0.0.1', routes: [{ kind: 'direct', host: '10.0.0.1' }] },
        { ...good, id: 'e', routes: [{ kind: 'direct', host: 'a.example.com', token: 'secret' }] },
      ]),
    );
    await loadDirect();
    expect(directStore.get().machines.map((m) => m.id)).toEqual(['a']);
  });

  it('refuses a route list that loses its own host or repeats a host', async () => {
    const r = await addDirect({ host: 'box.tail1.ts.net', instance: 'i' });
    await expect(updateDirect(r.id, () => ({ routes: [{ kind: 'direct', host: 'other.example.com' }] }))).rejects.toThrow();
    await expect(updateDirect(r.id, () => ({ routes: [r.routes[0]!, r.routes[0]!] }))).rejects.toThrow();
    expect(directStore.get().machines[0]!.routes).toEqual(r.routes);
  });

  it('finds a record by its own host or one of its direct routes', async () => {
    const r = await addDirect({ host: 'box.tail1.ts.net', instance: 'i' });
    await updateDirect(r.id, () => ({ routes: [...r.routes, { kind: 'direct', host: 'box.example.com' }] }));
    expect(findDirectByHost('box.example.com')?.id).toBe(r.id);
    expect(findDirectByHost('nope.example.com')).toBeUndefined();
  });
});

describe('the known-host guard', () => {
  it('names the org that owns a control plane or a listed machine, and the direct record that owns a route', async () => {
    orgStore.set({ loaded: true, orgs: [ORG] });
    machinesStore.set({ [ORG.id]: { state: 'ready', machines: [MACHINE], fetchedAt: 0 } });
    const r = await addDirect({ host: 'box.tail1.ts.net', instance: 'i' });
    await updateDirect(r.id, () => ({ routes: [...r.routes, { kind: 'org', orgId: ORG.id, machineId: MACHINE.id, host: MACHINE.hostname }] }));
    expect(hostOwner('cp.example.com')).toEqual({ kind: 'org', name: 'Ada Org' });
    expect(hostOwner('laptop-ada.example.com')).toEqual({ kind: 'org', name: 'Ada Org' });
    expect(hostOwner('box.tail1.ts.net')).toEqual({ kind: 'direct', label: 'box.tail1.ts.net' });
    expect(hostOwner('sub.box.tail1.ts.net')).toBeNull();
    expect(orgRouteTaken(ORG.id, MACHINE.id)).toBe(true);
  });
});

describe('removeDirect', () => {
  it('signs out of every direct route host before forgetting the record and the last machine', async () => {
    const r = await addDirect({ host: 'box.tail1.ts.net', instance: 'i' });
    await updateDirect(r.id, () => ({ routes: [...r.routes, { kind: 'org', orgId: ORG.id, machineId: MACHINE.id, host: MACHINE.hostname }, { kind: 'direct', host: 'box.example.com' }] }));
    settingsStore.set({ ...DEFAULT_SETTINGS, lastMachine: { directId: r.id } });
    const order: string[] = [];
    vi.mocked(Session.directSignOut).mockImplementation(async ({ host }) => (order.push(host), { kind: 'signed_out', serverEnded: host !== 'box.example.com' }));
    expect(await removeDirect(r.id)).toEqual({ kind: 'removed', serverEnded: false });
    expect(order).toEqual(['box.tail1.ts.net', 'box.example.com']);
    expect(directStore.get().machines).toEqual([]);
    expect(settingsStore.get().lastMachine).toBeNull();
  });

  it('keeps the record when the vault is locked, the native call rejects or storage fails', async () => {
    const r = await addDirect({ host: 'box.tail1.ts.net', instance: 'i' });
    vi.mocked(Session.directSignOut).mockResolvedValueOnce({ kind: 'vault_locked' });
    expect(await removeDirect(r.id)).toEqual({ kind: 'vault_locked' });
    vi.mocked(Session.directSignOut).mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'native_error' }));
    expect(await removeDirect(r.id)).toEqual({ kind: 'failed', code: 'native_error', signedOut: false });
    vi.mocked(Session.directSignOut).mockResolvedValueOnce({ kind: 'secure_storage_failed' });
    expect(await removeDirect(r.id)).toEqual({ kind: 'failed', code: 'secure_storage_failed', signedOut: false });
    expect(directStore.get().machines).toHaveLength(1);
  });
});

describe('org sign-out and erase', () => {
  it('signing out of an org drops its routes from direct machines and leaves the machines', async () => {
    orgStore.set({ loaded: true, orgs: [ORG] });
    const r = await addDirect({ host: 'box.tail1.ts.net', instance: 'i' });
    await updateDirect(r.id, () => ({ routes: [{ kind: 'org', orgId: ORG.id, machineId: MACHINE.id, host: MACHINE.hostname }, ...r.routes] }));
    await signOutOrg(ORG.id);
    expect(directStore.get().machines[0]!.routes).toEqual([{ kind: 'direct', host: 'box.tail1.ts.net' }]);
    expect(Session.directSignOut).not.toHaveBeenCalled();
    // Idempotent: nothing to drop writes nothing.
    vi.mocked(SecureStore.set).mockClear();
    await forgetOrgRoutes(ORG.id);
    expect(SecureStore.set).not.toHaveBeenCalled();
  });

  it('erase everything ends every direct session before the vault wipe, even when one fails', async () => {
    await addDirect({ host: 'a.example.com', instance: null });
    await addDirect({ host: 'b.example.com', instance: null });
    const order: string[] = [];
    vi.mocked(Session.directSignOut).mockImplementation(async ({ host }) => {
      order.push(host);
      if (host === 'a.example.com') throw new Error('offline');
      return { kind: 'signed_out', serverEnded: true };
    });
    vi.mocked(SecureStore.eraseAll).mockImplementationOnce(async () => void order.push('eraseAll'));
    await eraseEverything();
    expect(order).toEqual(['a.example.com', 'b.example.com', 'eraseAll']);
    expect(directStore.get()).toEqual({ loaded: true, machines: [] });
  });
});

/** Holds the next vault write until `release()`; later writes go straight through. */
function holdNextWrite() {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const real = vi.mocked(SecureStore.set).getMockImplementation()!;
  vi.mocked(SecureStore.set).mockImplementationOnce(async (o) => {
    await gate;
    return real(o);
  });
  return { release };
}
const onDisk = (): DirectRecord[] => JSON.parse(vault.get('direct/list') ?? '[]');
const hosts = (r: DirectRecord | undefined) => r?.routes.map((x) => x.host);

describe('catalog writes are serialized and computed from the current state', () => {
  it('a remove and a reorder of the same record, overlapping, both land on disk and in memory', async () => {
    const r = await addDirect({ host: 'a.example.com', instance: 'i' });
    await updateDirect(r.id, (c) => ({ routes: [...c.routes, { kind: 'direct', host: 'b.example.com' }, { kind: 'direct', host: 'c.example.com' }] }));
    const held = holdNextWrite();
    const removing = updateDirect(r.id, (c) => ({ routes: c.routes.filter((x) => x.host !== 'b.example.com') }));
    const moving = updateDirect(r.id, (c) => {
      const next = [...c.routes];
      const i = next.findIndex((x) => x.host === 'c.example.com');
      [next[i - 1], next[i]] = [next[i]!, next[i - 1]!];
      return { routes: next };
    });
    held.release();
    await Promise.all([removing, moving]);
    expect(hosts(directStore.get().machines[0])).toEqual(['c.example.com', 'a.example.com']);
    expect(onDisk()).toEqual(directStore.get().machines);
  });

  it('changes to different records made at once keep each other', async () => {
    const a = await addDirect({ host: 'a.example.com', instance: 'i' });
    const held = holdNextWrite();
    const adding = addDirect({ host: 'b.example.com', instance: null });
    const changing = updateDirect(a.id, () => ({ instance: 'j' }));
    held.release();
    await Promise.all([adding, changing]);
    expect(directStore.get().machines.map((m) => [m.host, m.instance])).toEqual([['a.example.com', 'j'], ['b.example.com', null]]);
    expect(onDisk()).toEqual(directStore.get().machines);
  });

  it('a failed write changes neither memory nor disk, and the next write still runs', async () => {
    await addDirect({ host: 'a.example.com', instance: 'i' });
    const before = JSON.stringify(directStore.get());
    vi.mocked(SecureStore.set).mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'native_error' }));
    await expect(addDirect({ host: 'b.example.com', instance: null })).rejects.toThrow();
    expect(JSON.stringify(directStore.get())).toBe(before);
    await addDirect({ host: 'c.example.com', instance: null });
    expect(onDisk().map((m) => m.host)).toEqual(['a.example.com', 'c.example.com']);
  });
});

describe('ambiguous catalogs', () => {
  const rec = (id: string, host: string, extra: string[] = []): DirectRecord => ({
    id,
    label: host,
    host,
    instance: null,
    addedAt: 'x',
    routes: [{ kind: 'direct', host }, ...extra.map((h) => ({ kind: 'direct' as const, host: h }))],
  });

  it('rejects both records sharing a route host, and both sharing an id, without signing anything out', async () => {
    vault.set('direct/list', JSON.stringify([rec('a', 'a.example.com', ['shared.example.com']), rec('b', 'b.example.com', ['shared.example.com']), rec('c', 'c.example.com'), rec('c', 'd.example.com'), rec('e', 'e.example.com')]));
    await loadDirect();
    expect(directStore.get().machines.map((m) => m.id)).toEqual(['e']);
    expect(Session.directSignOut).not.toHaveBeenCalled();
    expect(findDirectByHost('shared.example.com')).toBeUndefined();
  });

  it('a change that would make two records share a host is refused and writes nothing', async () => {
    const a = await addDirect({ host: 'a.example.com', instance: 'i' });
    await addDirect({ host: 'b.example.com', instance: 'i' });
    await expect(updateDirect(a.id, (c) => ({ routes: [...c.routes, { kind: 'direct', host: 'b.example.com' }] }))).rejects.toEqual(new CatalogRefusal('conflict'));
    await expect(addDirect({ host: 'a.example.com', instance: null })).rejects.toEqual(new CatalogRefusal('conflict'));
    expect(onDisk()).toHaveLength(2);
  });
});

describe('remove when the vault write fails after a native sign-out', () => {
  it('says the phone signed out but the record is still listed', async () => {
    const r = await addDirect({ host: 'a.example.com', instance: null });
    vi.mocked(SecureStore.set).mockRejectedValueOnce(Object.assign(new Error('disk'), { code: 'Bad Code!' }));
    expect(await removeDirect(r.id)).toEqual({ kind: 'failed', code: 'unknown', signedOut: true });
    expect(Session.directSignOut).toHaveBeenCalledWith({ host: 'a.example.com' });
    expect(directStore.get().machines).toHaveLength(1);
    expect(onDisk()).toHaveLength(1);
  });
});

describe('erase against queued catalog writes', () => {
  it('a write running or queued when Erase everything starts never lands afterwards', async () => {
    await addDirect({ host: 'a.example.com', instance: null });
    const held = holdNextWrite();
    const running = addDirect({ host: 'b.example.com', instance: null });
    const queued = addDirect({ host: 'c.example.com', instance: null });
    const erasing = eraseEverything();
    held.release();
    await erasing;
    await expect(running).rejects.toEqual(new CatalogRefusal('erased'));
    await expect(queued).rejects.toEqual(new CatalogRefusal('erased'));
    expect(directStore.get().machines).toEqual([]);
    expect(vault.get('direct/list')).toBeUndefined();
  });
});

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('the catalog stays closed for the whole of Erase everything', () => {
  /** Starts an add, an update and a remove now, and returns how each ended. */
  async function tryEverything(existing: DirectRecord) {
    const [add, update, remove, signIn] = await Promise.allSettled([
      addDirect({ host: 'late.example.com', instance: null }),
      updateDirect(existing.id, () => ({ instance: 'late' })),
      removeDirect(existing.id),
      withHost('late.example.com', async () => 'signed in'),
    ]);
    return { add, update, remove, signIn };
  }
  const refused = { status: 'rejected', reason: new CatalogRefusal('erased') };

  const phases: [string, () => { gate: Promise<void>; open: () => void }][] = [
    [
      'while a write already running drains',
      () => {
        const held = holdNextWrite();
        void addDirect({ host: 'b.example.com', instance: null }).catch(() => undefined);
        const d = deferred();
        void d.promise.then(held.release);
        return { gate: d.promise, open: d.resolve };
      },
    ],
    [
      'while saved machines are being signed out',
      () => {
        const d = deferred();
        vi.mocked(Session.directSignOut).mockImplementationOnce(async () => (await d.promise, { kind: 'signed_out', serverEnded: true }));
        return { gate: d.promise, open: d.resolve };
      },
    ],
    [
      'while the vault wipe runs',
      () => {
        const d = deferred();
        vi.mocked(SecureStore.eraseAll).mockImplementationOnce(async () => (await d.promise, vault.clear()));
        return { gate: d.promise, open: d.resolve };
      },
    ],
  ];
  for (const [name, arrange] of phases) {
    it(`refuses every change and sign-in started ${name}, and ends empty; a later add works`, async () => {
      const existing = await addDirect({ host: 'a.example.com', instance: null });
      const phase = arrange();
      // Let a write that phase holds actually reach the vault before the erase starts.
      await tick();
      let erased = false;
      const erasing = eraseEverything().then(() => (erased = true));
      await tick();
      const late = await tryEverything(existing);
      expect(erased).toBe(false);
      expect(late.add).toEqual(refused);
      expect(late.update).toEqual(refused);
      expect(late.remove).toEqual({ status: 'fulfilled', value: { kind: 'failed', code: 'erased', signedOut: false } });
      expect(late.signIn).toEqual(refused);
      phase.open();
      await erasing;
      expect(directStore.get().machines).toEqual([]);
      expect(vault.get('direct/list')).toBeUndefined();
      await addDirect({ host: 'after.example.com', instance: null });
      expect(onDisk().map((m) => m.host)).toEqual(['after.example.com']);
    });
  }

  it('a failed wipe reopens the catalog and rejects', async () => {
    vi.mocked(SecureStore.eraseAll).mockRejectedValueOnce(new Error('wipe failed'));
    await expect(eraseEverything()).rejects.toThrow('wipe failed');
    await addDirect({ host: 'after.example.com', instance: null });
    expect(directStore.get().machines.map((m) => m.host)).toContain('after.example.com');
  });
});

describe('a change abandoned while its vault write is out is undone in its own turn', () => {
  it('neither disk nor memory keeps it, and the other records stay', async () => {
    await addDirect({ host: 'a.example.com', instance: null });
    let gone = false;
    const held = holdNextWrite();
    const adding = addDirect({ host: 'b.example.com', instance: null }, () => gone);
    await tick();
    gone = true;
    held.release();
    await expect(adding).rejects.toEqual(new CatalogRefusal('abandoned'));
    expect(directStore.get().machines.map((m) => m.host)).toEqual(['a.example.com']);
    expect(onDisk().map((m) => m.host)).toEqual(['a.example.com']);
  });

  it('the same when an erase starts while it is out', async () => {
    await addDirect({ host: 'a.example.com', instance: null });
    const held = holdNextWrite();
    const adding = addDirect({ host: 'b.example.com', instance: null });
    await tick();
    const erasing = eraseEverything();
    held.release();
    await expect(adding).rejects.toEqual(new CatalogRefusal('erased'));
    await erasing;
    expect(directStore.get().machines).toEqual([]);
    expect(vault.get('direct/list')).toBeUndefined();
  });

  it('when the undo fails, says so and shows what the vault really holds', async () => {
    await addDirect({ host: 'a.example.com', instance: null });
    let gone = false;
    const held = holdNextWrite();
    const adding = addDirect({ host: 'b.example.com', instance: null }, () => gone);
    await tick();
    gone = true;
    vi.mocked(SecureStore.set).mockRejectedValueOnce(Object.assign(new Error('disk'), { code: 'native_error' }));
    held.release();
    await expect(adding).rejects.toEqual(new CatalogRefusal('rollback_failed'));
    expect(directStore.get().machines.map((m) => m.host)).toEqual(['a.example.com', 'b.example.com']);
    expect(onDisk()).toEqual(directStore.get().machines);
  });
});

describe('two erases at once are one erase', () => {
  it('the second joins the first: nothing it lets in can land, and both end empty', async () => {
    await addDirect({ host: 'a.example.com', instance: null });
    const wipe = deferred();
    vi.mocked(SecureStore.eraseAll).mockImplementationOnce(async () => (await wipe.promise, vault.clear()));
    const first = eraseEverything();
    await tick();
    const second = eraseEverything();
    // The second press must not reopen anything while the first wipe is still running.
    await expect(addDirect({ host: 'late.example.com', instance: null })).rejects.toEqual(new CatalogRefusal('erased'));
    wipe.resolve();
    await Promise.all([first, second]);
    expect(SecureStore.eraseAll).toHaveBeenCalledTimes(1);
    expect(directStore.get().machines).toEqual([]);
    expect(vault.get('direct/list')).toBeUndefined();
    await addDirect({ host: 'after.example.com', instance: null });
    expect(onDisk().map((m) => m.host)).toEqual(['after.example.com']);
  });
});

describe('Remove and a queued Sign in again on the same host', () => {
  it('a sign-in queued behind a Remove finds the machine gone and never reaches native', async () => {
    const r = await addDirect({ host: 'a.example.com', instance: null });
    const out = deferred();
    vi.mocked(Session.directSignOut).mockImplementationOnce(async () => (await out.promise, { kind: 'signed_out', serverEnded: true }));
    const removing = removeDirect(r.id);
    await tick();
    const signingIn = withHost('a.example.com', async () => (findDirectByHost('a.example.com') ? Session.directSignIn({ host: 'a.example.com' }) : 'gone'));
    out.resolve();
    expect(await removing).toEqual({ kind: 'removed', serverEnded: true });
    expect(await signingIn).toBe('gone');
    expect(Session.directSignIn).not.toHaveBeenCalled();
    expect(onDisk()).toEqual([]);
  });

  it('the metadata commit is inside the turn: a failed commit keeps the record a later sign-in belongs to', async () => {
    const r = await addDirect({ host: 'a.example.com', instance: null });
    vi.mocked(SecureStore.set).mockRejectedValueOnce(Object.assign(new Error('disk'), { code: 'native_error' }));
    const removing = removeDirect(r.id);
    const signingIn = withHost('a.example.com', async () => findDirectByHost('a.example.com')?.id);
    expect(await removing).toEqual({ kind: 'failed', code: 'native_error', signedOut: true });
    expect(await signingIn).toBe(r.id);
  });
});

describe('Remove never forgets a way to reach the machine that it did not sign out of', () => {
  it('B approved while the sign-out of A is out: the record stays with both, B keeps its metadata, and Remove again ends both', async () => {
    const A = 'box.tail1.ts.net';
    const B = 'box.example.com';
    const r = await addDirect({ host: A, instance: 'inst-1' });
    let release!: () => void;
    vi.mocked(Session.directSignOut).mockImplementationOnce(() => new Promise((ok) => (release = () => ok({ kind: 'signed_out', serverEnded: true }))));
    const removing = removeDirect(r.id);
    await vi.waitFor(() => expect(Session.directSignOut).toHaveBeenCalledWith({ host: A }));
    // "Ways to reach it" approves B (its own sign-in already happened in its own host turn).
    await updateDirect(r.id, (c) => ({ routes: [...c.routes, { kind: 'direct', host: B }] }));
    release();
    expect(await removing).toEqual({ kind: 'failed', code: 'routes_changed', signedOut: false });
    expect(vi.mocked(Session.directSignOut).mock.calls.map((c) => c[0].host)).toEqual([A]);
    expect(directStore.get().machines[0]!.routes.map((x) => x.host)).toEqual([A, B]);
    expect(JSON.parse(vault.get('direct/list')!)[0].routes.map((x: { host: string }) => x.host)).toEqual([A, B]);
    // Control: Remove again signs out of both and forgets the record.
    expect(await removeDirect(r.id)).toEqual({ kind: 'removed', serverEnded: true });
    expect(vi.mocked(Session.directSignOut).mock.calls.map((c) => c[0].host)).toEqual([A, A, B]);
    expect(directStore.get().machines).toEqual([]);
  });
});
