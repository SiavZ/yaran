/**
 * Ways to reach it (G2): a direct machine's user-approved routes, in the order native tries them.
 *
 * Every route is approved by the user here: an org machine this phone already lists, or a
 * typed HTTPS address that `DirectCheck` probes independently and must answer as the same
 * instance (signing in on its own when it needs a password). The list reorders with Move up /
 * Move down and loses a route with Remove; the machine's own address stays (Remove machine on
 * Machines forgets it). At most `MAX_ROUTES` routes.
 *
 * - The instance is public: it groups what the user approved and authorizes nothing. An org
 *   route is checked before it is saved with `Session.routeStatus`, which probes that host with
 *   its own org session only; when it has none the org sign-in for that machine runs first and
 *   the route is probed again. It must answer as the record's instance; nothing is saved on the
 *   user's word. Native checks every route again at each open.
 * - Every change is computed inside the catalog queue from the record as it is then: a machine
 *   removed, the route cap, a host already used, an org signed out or a machine gone from its
 *   list in the meantime all refuse, and nothing is written back from a stale screen. One route
 *   action runs at a time here; the others wait disabled.
 * - Removing a typed route signs that host out natively first; a failure keeps the route.
 * - The known-host guard refuses a host already used anywhere on this phone.
 *
 * <module-headers:begin>
 * Uses:
 * src/screens/machines/MachineRoutes.tsx
 * ├── @yaran/protocol:src/index.ts
 * ├── @yaran/ui-kit:src/button.tsx
 * ├── @yaran/ui-kit:src/inline-code.tsx
 * ├── @yaran/ui-kit:src/input.tsx
 * ├── src/lib/directStore.ts
 * ├── src/lib/erasure.ts
 * ├── src/lib/knownHosts.ts
 * ├── src/lib/machinesStore.ts
 * ├── src/lib/native/machineView.ts
 * ├── src/lib/notify.ts
 * ├── src/lib/openMachine.ts
 * ├── src/lib/orgStore.ts
 * ├── src/lib/orgUrl.ts
 * ├── src/lib/store.ts
 * ├── src/screens/Page.tsx
 * ├── src/screens/machines/DirectCheck.tsx
 * ├── src/screens/machines/directText.tsx
 * └── src/screens/onboarding/SignInResult.tsx
 * External: @lingui/core, @lingui/react, lucide-react, react
 *
 * Used by:
 * src/screens/machines/MachineRoutes.tsx
 * ├── src/App.tsx
 * ├── src/intakeBoundaries.test.tsx
 * ├── src/screens/machines/direct.test.tsx
 * └── src/screens/machines/upgradeRequired.test.tsx
 * <module-headers:end>
 */
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import type { MachineSummary } from '@yaran/protocol';
import { Button } from '@yaran/ui-kit/button';
import { InlineCode } from '@yaran/ui-kit/inline-code';
import { Input } from '@yaran/ui-kit/input';
import { ArrowDownIcon, ArrowUpIcon, Trash2Icon } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';

import { CatalogRefusal, directStore, updateDirect, withHost, type DirectRecord } from '../../lib/directStore.ts';
import { hostOwner, loadOrgLists, orgRouteTaken } from '../../lib/knownHosts.ts';
import { machinesStore } from '../../lib/machinesStore.ts';
import { MAX_ROUTES, Session, type MachineRoute } from '../../lib/native/machineView.ts';
import { notify } from '../../lib/notify.ts';
import { machineChoices, rejectionCode } from '../../lib/openMachine.ts';
import { eraseEpoch, erasing } from '../../lib/erasure.ts';
import { orgIncarnation, orgStore } from '../../lib/orgStore.ts';
import { machineRefusalMessage, normalizeTypedMachineHost } from '../../lib/orgUrl.ts';
import { useStore } from '../../lib/store.ts';
import { Page } from '../Page.tsx';
import { signInSentence, type SignInFailure } from '../onboarding/SignInResult.tsx';
import { DirectCheck } from './DirectCheck.tsx';
import { probeFailureText, type ProbeFailure } from './directText.tsx';

type Adding = { kind: 'none' } | { kind: 'typed'; host: string };

function routeName(route: MachineRoute, record: DirectRecord, orgName: (id: string) => string, machine: (r: Extract<MachineRoute, { kind: 'org' }>) => string) {
  if (route.kind === 'direct') {
    return route.host === record.host ? <Trans><InlineCode>{route.host}</InlineCode> (its own address)</Trans> : <InlineCode>{route.host}</InlineCode>;
  }
  return <Trans><InlineCode>{machine(route)}</InlineCode> through <InlineCode>{orgName(route.orgId)}</InlineCode></Trans>;
}

type Told = { tone: 'success' | 'error'; text: ReactNode };
const refuse = (text: ReactNode): Told => ({ tone: 'error', text });

/**
 * Checks an org machine as a route of record `id` with its own org session, signing in to that
 * machine first when it has none, and saves it only when it answers as the record's instance.
 * `owned` keeps the initiating screen and choice through preparation, queued save and undo.
 */
export async function addCheckedOrgRoute(id: string, orgId: string, m: MachineSummary, owned: () => boolean = () => true): Promise<Told> {
  const name = <InlineCode>{m.name}</InlineCode>;
  const route: MachineRoute = { kind: 'org', orgId, machineId: m.id, host: m.hostname };
  // The org as it is now: one signed out, erased, or removed and added again while this runs is
  // another org, and nothing of this check (a sign-in, a probe, the save) acts on it.
  const inc = orgIncarnation(orgId);
  const epoch = eraseEpoch();
  const stale = () => !owned() || inc === undefined || orgIncarnation(orgId) !== inc || eraseEpoch() !== epoch || erasing();
  const changed = () => refuse(<Trans>{name}'s org changed on this phone while it was being checked, so it wasn't added.</Trans>);
  const probe = () => Session.routeStatus({ route }).catch((err: unknown): ProbeFailure => ({ kind: 'rejected', code: rejectionCode(err) }));
  if (stale()) return changed();
  let status = await probe();
  if (stale()) return changed();
  if (status.kind === 'sign_in_required') {
    const out = await Session.signIn({ orgId, target: { machineHost: m.hostname } }).catch((err: unknown): SignInFailure => ({ kind: 'rejected', code: rejectionCode(err) }));
    if (stale()) return changed();
    if (out.kind !== 'signed_in') return refuse(signInSentence(out, m.hostname).text);
    status = await probe();
    if (stale()) return changed();
  }
  if (status.kind === 'sign_in_required') return refuse(<Trans>{name} still asks for a sign-in, so it wasn't added. Try again.</Trans>);
  if (status.kind !== 'yaran') return refuse(probeFailureText(status, m.hostname).text);
  // The probe and the sign-in took time: decide on the catalog as it is when this write's turn comes.
  try {
    const saved = await updateDirect(
      id,
      (current) => {
        if (stale()) throw new Refused(<Trans>{name}'s org changed on this phone while it was being checked, so it wasn't added.</Trans>);
        const label = <InlineCode>{current.label}</InlineCode>;
        if (current.instance === null || status.instance !== current.instance) {
          throw new Refused(<Trans>A different yaran answers at {name}, so it can't be a way to reach {label}.</Trans>);
        }
        if (current.routes.length >= MAX_ROUTES) throw new Refused(<Trans>{label} already has {MAX_ROUTES} ways to reach it. Remove one to add another.</Trans>);
        if (current.routes.some((r) => r.host === m.hostname) || orgRouteTaken(orgId, m.id)) {
          throw new Refused(<Trans>{name} is already a way to reach a direct machine.</Trans>);
        }
        const stillListed = orgStore.get().orgs.some((o) => o.id === orgId) && (machinesStore.get()[orgId]?.machines ?? []).some((x) => x.id === m.id && x.hostname === m.hostname);
        if (!stillListed) throw new Refused(<Trans>{name} is no longer in its org's list on this phone, so it wasn't added.</Trans>);
        return { routes: [...current.routes, route] };
      },
      // Checked again once written: an org that changed while the write was out undoes it.
      stale,
    );
    if (stale()) return changed();
    return { tone: 'success', text: <Trans>Added {name} as a way to reach <InlineCode>{saved.label}</InlineCode>. It answered as the same machine.</Trans> };
  } catch (err) {
    const text = changeFailure(err);
    // A failed undo keeps the saved route listed: tell the person even after the screen went away.
    if (!owned() && err instanceof CatalogRefusal && err.code === 'rollback_failed') notify('error', text);
    return refuse(text);
  }
}

/** A change refused with its own sentence. */
class Refused extends Error {
  constructor(readonly told: ReactNode) {
    super('refused');
  }
}

function changeFailure(err: unknown): ReactNode {
  if (err instanceof Refused) return err.told;
  if (err instanceof CatalogRefusal && err.code === 'gone') return <Trans>That machine isn't on this phone any more.</Trans>;
  if (err instanceof CatalogRefusal && err.code === 'rollback_failed') return <Trans>The app couldn't undo the route change. The saved change is still listed; check it in Ways to reach it.</Trans>;
  const code = <InlineCode>{rejectionCode(err)}</InlineCode>;
  return <Trans>The app couldn't save the change ({code}). Nothing changed; try again.</Trans>;
}

/** Writes one change from the record's current state; says why when it is refused. */
async function change(id: string, fn: Parameters<typeof updateDirect>[1]): Promise<boolean> {
  try {
    await updateDirect(id, fn);
    return true;
  } catch (err) {
    notify('error', changeFailure(err));
    return false;
  }
}

export function MachineRoutes({ id }: { id: string }) {
  const { i18n } = useLingui();
  const record = useStore(directStore).machines.find((m) => m.id === id);
  const { orgs } = useStore(orgStore);
  const lists = useStore(machinesStore);
  const [adding, setAdding] = useState<Adding>({ kind: 'none' });
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  // One route action at a time on this screen; the catalog queue orders writes across screens.
  const [busy, setBusy] = useState(false);
  const busyNow = useRef(false);
  const mounted = useRef(true);
  const fieldId = useId();

  useEffect(() => {
    mounted.current = true;
    void loadOrgLists();
    return () => { mounted.current = false; };
  }, []);

  if (!record) {
    return (
      <Page title={<Trans>Ways to reach it</Trans>} back={{ name: 'machines' }}>
        <p role="alert">
          <Trans>That machine isn't on this phone any more.</Trans>
        </p>
      </Page>
    );
  }
  const rec = record;
  const orgName = (orgId: string) => orgs.find((o) => o.id === orgId)?.name ?? orgId;
  const machineName = (r: Extract<MachineRoute, { kind: 'org' }>) => lists[r.orgId]?.machines.find((m) => m.id === r.machineId)?.name ?? r.host;
  const full = rec.routes.length >= MAX_ROUTES;
  const label = <InlineCode>{rec.label}</InlineCode>;

  async function exclusive(job: (owned: () => boolean) => Promise<void>): Promise<void> {
    if (busyNow.current || !mounted.current) return;
    const from = window.location.hash;
    const choices = machineChoices();
    const owned = () => mounted.current && window.location.hash === from && machineChoices() === choices;
    busyNow.current = true;
    setBusy(true);
    try {
      await job(owned);
    } finally {
      busyNow.current = false;
      if (mounted.current) { setBusy(false); setChecking(null); }
    }
  }

  const move = (host: string, by: -1 | 1) =>
    exclusive(async () => {
      const moved = await change(rec.id, (current) => {
        const next = [...current.routes];
        const index = next.findIndex((r) => r.host === host);
        if (index < 0 || !next[index + by]) throw new Refused(<Trans>That way to reach {label} changed meanwhile; nothing moved.</Trans>);
        [next[index], next[index + by]] = [next[index + by]!, next[index]!];
        return { routes: next };
      });
      if (moved) notify('success', <Trans>Moved. The app tries the ways to reach {label} in this order.</Trans>);
    });

  const remove = (route: MachineRoute) =>
    exclusive(async () => {
      if (route.kind === 'direct') {
        const out = await withHost(route.host, () => Session.directSignOut({ host: route.host })).catch((err: unknown) => ({ kind: 'rejected' as const, code: rejectionCode(err) }));
        if (out.kind === 'vault_locked') return notify('error', <Trans>Unlock the app, then try again.</Trans>);
        // `not_current` here (no id given) means a newer sign-in survived: the host still has a session.
        if (out.kind === 'rejected' || out.kind === 'secure_storage_failed' || out.kind === 'not_current') {
          const code = <InlineCode>{out.kind === 'rejected' ? out.code : out.kind}</InlineCode>;
          return notify('error', <Trans>The app couldn't sign out of <InlineCode>{route.host}</InlineCode> ({code}), so the route stays. Try again.</Trans>);
        }
      }
      const removed = await change(rec.id, (current) => ({ routes: current.routes.filter((r) => r.host !== route.host) }));
      if (removed) notify('success', <Trans>Removed that way to reach {label}.</Trans>);
    });

  const addOrgRoute = (orgId: string, m: MachineSummary) =>
    exclusive(async (owned) => {
      setChecking(m.id);
      const told = await addCheckedOrgRoute(rec.id, orgId, m, owned);
      if (owned()) notify(told.tone, told.text);
    });

  function submitTyped(e: FormEvent) {
    e.preventDefault();
    const got = normalizeTypedMachineHost(typed);
    if (!got.ok) return setError(i18n._(machineRefusalMessage(got.refused)));
    const owner = hostOwner(got.host);
    if (owner) return setError(i18n._(msg`That address is already used on this phone (by ${owner.kind === 'org' ? owner.name : owner.label}).`));
    setAdding({ kind: 'typed', host: got.host });
  }

  async function addTyped(host: string, cancelled: () => boolean) {
    const expected = rec.instance;
    await updateDirect(rec.id, (current) => {
      if (cancelled()) throw new CatalogRefusal('abandoned');
      if (current.instance !== expected || hostOwner(host) || current.routes.length >= MAX_ROUTES) throw new CatalogRefusal('conflict');
      return { routes: [...current.routes, { kind: 'direct', host }] };
      // Checked again once written: an org claiming the host meanwhile undoes it.
    }, () => cancelled() || hostOwner(host) !== null);
    if (cancelled()) return;
    setAdding({ kind: 'none' });
    setTyped('');
    notify('success', <Trans>Added <InlineCode>{host}</InlineCode> as a way to reach {label}.</Trans>);
  }

  const candidates = orgs.flatMap((o) =>
    (lists[o.id]?.machines ?? [])
      .filter((m) => m.status !== 'tearing_down' && !orgRouteTaken(o.id, m.id) && !rec.routes.some((r) => r.host === m.hostname))
      .map((m) => ({ org: o, machine: m })),
  );

  return (
    <Page title={<Trans>Ways to reach {label}</Trans>} back={{ name: 'machines' }}>
      <p className="text-sm leading-relaxed text-muted-foreground">
        <Trans>
          The app tries these in order each time it opens the machine and uses the first one that answers as this machine. Each one signs in on its own;
          none shares another's sign-in. Another way is another browser to the machine, with its own drafts.
        </Trans>
      </p>
      <ol className="flex flex-col gap-2">
        {rec.routes.map((r, i) => (
          <li key={r.host} className="flex min-h-14 items-center gap-2 rounded-xl border border-border bg-card p-3 [overflow-wrap:anywhere]">
            <span className="min-w-0 flex-1 text-sm">{routeName(r, rec, orgName, machineName)}</span>
            <Button variant="ghost" size="icon-lg" className="size-12 min-h-12" disabled={busy || i === 0} aria-label={i18n._(msg`Move up`)} onClick={() => void move(r.host, -1)}>
              <ArrowUpIcon aria-hidden />
            </Button>
            <Button variant="ghost" size="icon-lg" className="size-12 min-h-12" disabled={busy || i === rec.routes.length - 1} aria-label={i18n._(msg`Move down`)} onClick={() => void move(r.host, 1)}>
              <ArrowDownIcon aria-hidden />
            </Button>
            {!(r.kind === 'direct' && r.host === rec.host) && (
              <Button variant="ghost" size="icon-lg" className="size-12 min-h-12" disabled={busy} aria-label={i18n._(msg`Remove this way`)} onClick={() => void remove(r)}>
                <Trash2Icon aria-hidden />
              </Button>
            )}
          </li>
        ))}
      </ol>
      {rec.instance === null ? (
        <p role="note" className="text-sm text-muted-foreground">
          <Trans>This machine doesn't report an identity, so the app can't check that another address reaches the same machine.</Trans>
        </p>
      ) : full ? (
        <p role="note" className="text-sm text-muted-foreground">
          <Trans>A machine can have up to {MAX_ROUTES} ways to reach it. Remove one to add another.</Trans>
        </p>
      ) : (
        <>
          <h2 className="text-lg font-semibold">
            <Trans>Add another way to reach it</Trans>
          </h2>
          {candidates.length > 0 && (
            <section className="flex flex-col gap-2">
              <p className="text-sm text-muted-foreground">
                <Trans>Through an org on this phone. The app checks that it answers as this machine, signing in to it first if needed, before adding it.</Trans>
              </p>
              <ul className="flex flex-col gap-2">
                {candidates.map(({ org, machine }) => (
                  <li key={machine.id}>
                    <Button className="min-h-12 w-full justify-start" variant="outline" disabled={busy} onClick={() => void addOrgRoute(org.id, machine)}>
                      {checking === machine.id ? (
                        <Trans>
                          Checking <InlineCode>{machine.name}</InlineCode>…
                        </Trans>
                      ) : (
                        <Trans>
                          Add <InlineCode>{machine.name}</InlineCode> through <InlineCode>{org.name}</InlineCode>
                        </Trans>
                      )}
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {adding.kind === 'typed' ? (
            <section className="flex flex-col gap-3">
              <p>
                <Trans>
                  Address: <InlineCode>{adding.host}</InlineCode>
                </Trans>
              </p>
              <DirectCheck key={adding.host} host={adding.host} expectInstance={rec.instance} approveLabel={<Trans>Add this way</Trans>} onApproved={(_, cancelled) => addTyped(adding.host, cancelled)} />
              <Button className="min-h-12" variant="ghost" onClick={() => setAdding({ kind: 'none' })}>
                <Trans>Cancel</Trans>
              </Button>
            </section>
          ) : (
            <form className="flex flex-col gap-3" onSubmit={submitTyped} noValidate>
              <label htmlFor={fieldId} className="text-sm font-medium">
                <Trans>Another HTTPS address</Trans>
              </label>
              <Input
                id={fieldId}
                className="min-h-12"
                inputMode="url"
                enterKeyHint="go"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder="laptop.example.com"
                value={typed}
                aria-invalid={error !== null}
                aria-describedby={error ? `${fieldId}-error` : undefined}
                onChange={(e) => {
                  setTyped(e.target.value);
                  setError(null);
                }}
              />
              {error && (
                <p id={`${fieldId}-error`} role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
              <Button type="submit" className="min-h-12" variant="outline">
                <Trans>Check this address</Trans>
              </Button>
            </form>
          )}
        </>
      )}
    </Page>
  );
}
