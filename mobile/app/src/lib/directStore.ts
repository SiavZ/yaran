/**
 * Direct machines (G1, G2): machines this phone reaches over HTTPS without Cloud Connect.
 *
 * A record is metadata only, kept in the vault's `direct` namespace under `list`:
 * `{id, label, host, instance, addedAt, routes}`. The machine's session token (when it has a
 * password) lives natively under `session-direct/<host>` and never reaches this module. The
 * record's own host is always one of its routes, so removing it means removing the machine;
 * the other routes are user-approved alternatives in the user's order (at most `MAX_ROUTES`).
 *
 * - The instance id is public: it groups routes and authorizes nothing.
 * - Remove signs out of every direct route host natively before forgetting the record, and
 *   keeps the record when the vault is locked or the native call fails, so nothing is lost.
 * - A corrupt list is dropped loudly rather than half-read.
 *
 * <module-headers:begin>
 * Uses:
 * src/lib/directStore.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── @yaran/secure-store:src/index.ts
 * ├── src/lib/diagnostics.ts
 * ├── src/lib/erasure.ts
 * ├── src/lib/native/machineView.ts
 * ├── src/lib/settingsStore.ts
 * └── src/lib/store.ts
 * External: none
 *
 * Used by:
 * src/lib/directStore.ts
 * ├── src/App.tsx
 * ├── src/approvalNavigation.test.tsx
 * ├── src/explicitOpen.test.tsx
 * ├── src/intakeBoundaries.test.tsx
 * ├── src/lib/deepLinks.test.ts
 * ├── src/lib/deepLinks.ts
 * ├── src/lib/directStore.test.ts
 * ├── src/lib/knownHosts.ts
 * ├── src/lib/lifecycle.test.ts
 * ├── src/lib/lifecycle.ts
 * ├── src/lib/openMachine.test.ts
 * ├── src/lib/openMachine.ts
 * ├── src/lib/orgStore.ts
 * ├── src/main.tsx
 * ├── src/modalNavigation.test.tsx
 * ├── src/reopenPriority.test.tsx
 * ├── src/screens/machines/DirectCheck.tsx
 * ├── src/screens/machines/DirectSection.tsx
 * ├── src/screens/machines/InstanceChangedDialog.tsx
 * ├── src/screens/machines/MachineList.tsx
 * ├── src/screens/machines/MachineRoutes.tsx
 * ├── src/screens/machines/ShareTarget.tsx
 * ├── src/screens/machines/approval.test.tsx
 * ├── src/screens/machines/direct.test.tsx
 * ├── src/screens/machines/instanceChanged.test.tsx
 * ├── src/screens/machines/upgradeRequired.test.tsx
 * ├── src/screens/onboarding/ConfirmMachine.tsx
 * ├── src/screens/onboarding/EnterUrl.tsx
 * └── src/test/setup.ts
 * <module-headers:end>
 */
import { isPublicHost } from '@yaran/protocol';
import { SecureStore } from '@yaran/secure-store';

import { log } from './diagnostics.ts';
import { MAX_ROUTES, Session, type DirectSignOutOutcome, type MachineRoute } from './native/machineView.ts';
import { eraseEpoch, erasing } from './erasure.ts';
import { forgetLastDirect } from './settingsStore.ts';
import { createStore } from './store.ts';

export interface DirectRecord {
  id: string;
  label: string;
  host: string;
  /** The machine's public instance id when it reported one; routes need it. */
  instance: string | null;
  addedAt: string;
  /** Every way to reach the machine, in the user's order; always includes `{kind:'direct', host}`. */
  routes: MachineRoute[];
}

export interface DirectState {
  loaded: boolean;
  machines: DirectRecord[];
}

const NS = { namespace: 'direct', key: 'list' } as const;
export const directStore = createStore<DirectState>({ loaded: false, machines: [] });

function isRoute(v: unknown): v is MachineRoute {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  if (typeof r.host !== 'string' || !isPublicHost(r.host)) return false;
  if (r.kind === 'direct') return Object.keys(r).length === 2;
  return r.kind === 'org' && typeof r.orgId === 'string' && typeof r.machineId === 'string';
}

function isRecord(v: unknown): v is DirectRecord {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  if (
    typeof r.id !== 'string' ||
    typeof r.label !== 'string' ||
    typeof r.host !== 'string' ||
    !isPublicHost(r.host) ||
    !(r.instance === null || typeof r.instance === 'string') ||
    typeof r.addedAt !== 'string' ||
    !Array.isArray(r.routes) ||
    r.routes.length < 1 ||
    r.routes.length > MAX_ROUTES ||
    !r.routes.every(isRoute)
  ) {
    return false;
  }
  const hosts = (r.routes as MachineRoute[]).map((x) => x.host);
  return new Set(hosts).size === hosts.length && (r.routes as MachineRoute[]).some((x) => x.kind === 'direct' && x.host === r.host);
}

/**
 * A catalog where no two records share an id or any route host. Two records naming one host
 * would make every host lookup ambiguous and let removing one sign the other out, so both
 * records are rejected rather than either winning.
 */
function unambiguous(machines: DirectRecord[]): { kept: DirectRecord[]; rejected: number } {
  const ids = new Map<string, number>();
  const hosts = new Map<string, number>();
  for (const m of machines) {
    ids.set(m.id, (ids.get(m.id) ?? 0) + 1);
    for (const r of m.routes) hosts.set(r.host, (hosts.get(r.host) ?? 0) + 1);
  }
  const kept = machines.filter((m) => ids.get(m.id) === 1 && m.routes.every((r) => hosts.get(r.host) === 1));
  return { kept, rejected: machines.length - kept.length };
}

export async function loadDirect(): Promise<void> {
  let machines: DirectRecord[] = [];
  try {
    const { value } = await SecureStore.get(NS);
    const parsed: unknown = value === null ? [] : JSON.parse(value);
    const wellFormed = Array.isArray(parsed) ? parsed.filter(isRecord) : [];
    if (Array.isArray(parsed) && wellFormed.length !== parsed.length) log('warn', 'dropped malformed direct machine records from the vault');
    const { kept, rejected } = unambiguous(wellFormed);
    // Nothing is merged and no session is touched: the ambiguous records are simply not offered.
    if (rejected > 0) log('warn', `rejected ${rejected} direct machine records that share an id or an address with another`);
    machines = kept;
  } catch (err) {
    log('error', `could not read the direct machine list: ${err instanceof Error ? err.message : String(err)}`);
  }
  directStore.set({ loaded: true, machines });
}

/** A refusal raised inside a catalog change; `code` is a safe token for toasts and the log. */
export class CatalogRefusal extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

// One write at a time, each computed from the catalog as it is when its turn comes.
let queue: Promise<unknown> = Promise.resolve();

/** The erase epoch (see `erasure.ts`): a change queued or started before an erase never writes after it. */
export function directGeneration(): number {
  return eraseEpoch();
}

/**
 * Runs `change` on the current catalog in turn, validates the result, writes it, then shows it.
 * `change` may throw (a `CatalogRefusal` or anything else) to write nothing. When `cancelled`
 * (or an erase) turns true while the write is out, the write is undone in the same turn from
 * the catalog as it stood before it; if that undo fails, the written catalog is what is shown
 * and the change rejects with `rollback_failed`, so nothing claims a record is gone that is not.
 */
function mutate<T>(
  change: (machines: DirectRecord[]) => { machines: DirectRecord[]; result: T },
  cancelled: () => boolean = () => false,
): Promise<T> {
  if (erasing()) return Promise.reject(new CatalogRefusal('erased'));
  const asOf = eraseEpoch();
  const stale = () => asOf !== eraseEpoch() || cancelled();
  const run = queue.then(async () => {
    if (stale()) throw new CatalogRefusal(asOf !== eraseEpoch() ? 'erased' : 'abandoned');
    const before = directStore.get().machines;
    const { machines, result } = change(before);
    if (!machines.every(isRecord) || unambiguous(machines).rejected > 0) throw new CatalogRefusal('conflict');
    await SecureStore.set({ ...NS, value: JSON.stringify(machines), protection: 'standard' });
    if (stale()) {
      try {
        await SecureStore.set({ ...NS, value: JSON.stringify(before), protection: 'standard' });
      } catch (err) {
        log('error', `could not undo an abandoned direct machine change (${codeOf(err)}); keeping it listed`);
        directStore.set({ loaded: true, machines });
        throw new CatalogRefusal('rollback_failed');
      }
      throw new CatalogRefusal(asOf !== eraseEpoch() ? 'erased' : 'abandoned');
    }
    directStore.set({ loaded: true, machines });
    return result;
  });
  queue = run.catch(() => undefined);
  return run;
}

// Direct sign-in and sign-out run one at a time per host, each with its own clean-up inside its
// turn, so one operation never ends a session another minted, nor leaves one without a record.
const hostTurns = new Map<string, Promise<unknown>>();

/** Runs `job` as the only direct sign-in or sign-out on `host`; refused while erasing. */
export function withHost<T>(host: string, job: () => Promise<T>): Promise<T> {
  if (erasing()) return Promise.reject(new CatalogRefusal('erased'));
  const run = (hostTurns.get(host) ?? Promise.resolve()).then(job);
  const tail = run.catch(() => undefined);
  hostTurns.set(host, tail);
  void tail.then(() => hostTurns.get(host) === tail && hostTurns.delete(host));
  return run;
}

export function findDirect(id: string): DirectRecord | undefined {
  return directStore.get().machines.find((m) => m.id === id);
}

/** The record one of whose direct routes is `host` (its own host first). */
export function findDirectByHost(host: string): DirectRecord | undefined {
  const all = directStore.get().machines;
  return all.find((m) => m.host === host) ?? all.find((m) => m.routes.some((r) => r.kind === 'direct' && r.host === host));
}

/** The hosts this phone may hold a direct session for: every direct route of the record. */
export function directHosts(record: DirectRecord): string[] {
  return record.routes.filter((r) => r.kind === 'direct').map((r) => r.host);
}

/** Adds a machine; `abandoned` is asked when the write's turn comes and again once it is written. */
export function addDirect(entry: { host: string; instance: string | null }, abandoned: () => boolean = () => false): Promise<DirectRecord> {
  const record: DirectRecord = {
    id: crypto.randomUUID(),
    label: entry.host,
    host: entry.host,
    instance: entry.instance,
    addedAt: new Date().toISOString(),
    routes: [{ kind: 'direct', host: entry.host }],
  };
  return mutate((machines) => ({ machines: [...machines, record], result: record }), abandoned);
}

/**
 * Rewrites a record's instance or routes from what it is when this change's turn comes; the
 * result is re-validated with the whole catalog. `change` throws to refuse.
 */
export function updateDirect(
  id: string,
  change: (current: DirectRecord) => Partial<Pick<DirectRecord, 'instance' | 'routes'>>,
  abandoned: () => boolean = () => false,
): Promise<DirectRecord> {
  return mutate((machines) => {
    const current = machines.find((m) => m.id === id);
    if (!current) throw new CatalogRefusal('gone');
    const next = { ...current, ...change(current) };
    return { machines: machines.map((m) => (m.id === id ? next : m)), result: next };
  }, abandoned);
}

function codeOf(err: unknown): string {
  if (err instanceof CatalogRefusal) return err.code;
  const code = typeof err === 'object' && err !== null && 'code' in err ? (err as { code: unknown }).code : undefined;
  return typeof code === 'string' && /^[a-z0-9_]{1,64}$/.test(code) ? code : 'unknown';
}

export type RemoveDirectResult =
  | { kind: 'removed'; serverEnded: boolean }
  | { kind: 'vault_locked' }
  /** `signedOut`: native ended every session, but the record could not be forgotten and is still listed. */
  | { kind: 'failed'; code: string; signedOut: boolean };

/** Runs `job` holding the same-host turn of every host in `hosts` (taken in a fixed order). */
function withHosts<T>(hosts: string[], job: () => Promise<T>): Promise<T> {
  const [first, ...rest] = [...new Set(hosts)].sort();
  return first === undefined ? job() : withHost(first, () => withHosts(rest, job));
}

/**
 * Signs out of every direct route host, then forgets the record, all inside those hosts' turns:
 * a Sign in again queued behind it finds the machine gone instead of minting a session with no
 * record. Keeps the record on any failure.
 */
export async function removeDirect(id: string): Promise<RemoveDirectResult> {
  const record = findDirect(id);
  if (!record) return { kind: 'removed', serverEnded: false };
  let result: RemoveDirectResult;
  try {
    result = await withHosts(directHosts(record), async () => {
      const current = findDirect(id);
      if (!current) return { kind: 'removed', serverEnded: false };
      let serverEnded = true;
      for (const host of directHosts(current)) {
        let out: DirectSignOutOutcome;
        try {
          out = await Session.directSignOut({ host });
        } catch (err) {
          const code = codeOf(err);
          log('warn', `direct sign-out was rejected natively (${code})`);
          return { kind: 'failed', code, signedOut: false };
        }
        if (out.kind === 'vault_locked') return out;
        // The session record survived: keep ours too, so Remove can be tried again rather than orphaning it.
        if (out.kind === 'secure_storage_failed') return { kind: 'failed', code: out.kind, signedOut: false };
        // Host-only `not_current`: sign-ins kept landing and native kept the newest, so the host still
        // has a session. The machine stays listed, so it can be removed again.
        if (out.kind === 'not_current') return { kind: 'failed', code: out.kind, signedOut: false };
        // `invalid_host` means native never held anything for it: nothing is left to end.
        if (out.kind === 'signed_out') serverEnded &&= out.serverEnded;
      }
      const signedOut = directHosts(current);
      try {
        await mutate((machines) => {
          // A way to reach it approved while these sign-outs ran has a session of its own that
          // nothing here ended: forgetting the record would orphan it, so it stays to remove again.
          const now = machines.find((m) => m.id === id);
          if (now && directHosts(now).some((h) => !signedOut.includes(h))) throw new CatalogRefusal('routes_changed');
          return { machines: machines.filter((m) => m.id !== id), result: undefined };
        });
      } catch (err) {
        const code = codeOf(err);
        // A route added meanwhile still has its session: not every session was ended.
        if (code === 'routes_changed') return { kind: 'failed', code, signedOut: false };
        log('warn', `signed out of a direct machine but could not forget it (${code})`);
        return { kind: 'failed', code, signedOut: true };
      }
      return { kind: 'removed', serverEnded };
    });
  } catch (err) {
    // Refused before it began (an erase is running): nothing was signed out.
    return { kind: 'failed', code: codeOf(err), signedOut: false };
  }
  if (result.kind === 'removed') await forgetLastDirect(id).catch(() => undefined);
  return result;
}

/** Drops the routes through an org this phone left; the records themselves stay. */
export async function forgetOrgRoutes(orgId: string): Promise<void> {
  const through = (m: DirectRecord) => m.routes.some((r) => r.kind === 'org' && r.orgId === orgId);
  if (!directStore.get().machines.some(through)) return;
  await mutate((machines) => ({ machines: machines.map((m) => ({ ...m, routes: m.routes.filter((r) => r.kind !== 'org' || r.orgId !== orgId) })), result: undefined }));
}

/** Erase, first: wait for every catalog change and same-host turn already queued or running. */
export async function drainDirect(): Promise<void> {
  await queue;
  await Promise.all(hostTurns.values());
}

/** Erase: end each saved machine's session natively (best effort; the wipe removes them locally). */
export async function signOutAllDirect(): Promise<void> {
  for (const record of directStore.get().machines) {
    for (const host of directHosts(record)) {
      await Session.directSignOut({ host }).catch(() => log('warn', 'direct sign-out failed during erase; the vault wipe still removes its session'));
    }
  }
}

/** Erase, last, and tests: forget the list in memory. */
export function resetDirect(): void {
  directStore.set({ loaded: true, machines: [] });
}
