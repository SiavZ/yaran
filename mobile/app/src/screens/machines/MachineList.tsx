/**
 * Machines: every machine of every added org, grouped by org when there is more than one,
 * then the direct machines (reached over HTTPS without Cloud Connect), and Add a machine.
 *
 * Refreshes on entry, on resume (lifecycle), on the Refresh button and every 30 s of visible
 * time while shown. Per-org failures render in place: offline, an expired sign-in (with a
 * Sign in button), a removed phone (the org is removed and the phone-removed screen shown),
 * or the error sentence. Open hands the machine to Phase 15's `MachineView`.
 *
 * - Org and machine names are org-supplied text, rendered as React text.
 *
 * <module-headers:begin>
 * Uses:
 * src/screens/machines/MachineList.tsx
 * ├── @yaran/protocol:src/index.ts
 * ├── @yaran/ui-kit:src/button.tsx
 * ├── src/lib/api.ts
 * ├── src/lib/diagnostics.ts
 * ├── src/lib/directStore.ts
 * ├── src/lib/machinesStore.ts
 * ├── src/lib/native/machineView.ts
 * ├── src/lib/notify.ts
 * ├── src/lib/openMachine.ts
 * ├── src/lib/orgStore.ts
 * ├── src/lib/route.ts
 * ├── src/lib/settingsStore.ts
 * ├── src/lib/store.ts
 * ├── src/lib/visibleClock.ts
 * ├── src/screens/Page.tsx
 * ├── src/screens/machines/DirectSection.tsx
 * ├── src/screens/machines/MachineRow.tsx
 * ├── src/screens/machines/RemoveMachineDialog.tsx
 * ├── src/screens/machines/states/Empty.tsx
 * ├── src/screens/machines/states/ErrorState.tsx
 * ├── src/screens/machines/states/Offline.tsx
 * └── src/screens/onboarding/SignInResult.tsx
 * External: @lingui/core, @lingui/react, lucide-react, react
 *
 * Used by:
 * src/screens/machines/MachineList.tsx
 * ├── src/App.tsx
 * ├── src/push/pushWiring.test.ts
 * ├── src/screens/machines/direct.test.tsx
 * ├── src/screens/machines/machines.test.tsx
 * └── src/screens/machines/upgradeRequired.test.tsx
 * <module-headers:end>
 */
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import type { MachineSummary } from '@yaran/protocol';
import { Button } from '@yaran/ui-kit/button';
import { LoaderCircleIcon, PlusIcon, RefreshCwIcon, ShieldAlertIcon } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import type { ApiFailure } from '../../lib/api.ts';
import { directStore } from '../../lib/directStore.ts';
import { MACHINE_POLL_MS, machinesStore, refreshMachines, type OrgMachines } from '../../lib/machinesStore.ts';
import { Session } from '../../lib/native/machineView.ts';
import { log } from '../../lib/diagnostics.ts';
import { notify } from '../../lib/notify.ts';
import { choseMachine, openFailureMessage, openMachine, rejectionCode } from '../../lib/openMachine.ts';
import { handleDeviceRevoked, orgIncarnation, orgStore, type OrgRecord } from '../../lib/orgStore.ts';
import { navigate } from '../../lib/route.ts';
import { updateSettings } from '../../lib/settingsStore.ts';
import { useStore } from '../../lib/store.ts';
import { visibleInterval } from '../../lib/visibleClock.ts';
import { Page } from '../Page.tsx';
import { SignInResult, type SignInFailure } from '../onboarding/SignInResult.tsx';
import { DirectSection } from './DirectSection.tsx';
import { MachineRow } from './MachineRow.tsx';
import { RemoveMachineDialog } from './RemoveMachineDialog.tsx';
import { NoMachines, NoOrgs } from './states/Empty.tsx';
import { ErrorState } from './states/ErrorState.tsx';
import { Offline } from './states/Offline.tsx';

/**
 * Routes a device_revoked answer to the phone-removed screen; other failures stay in place.
 * `inc` is the org's incarnation when the request went out: an org removed (or erased) and
 * added again meanwhile is a different one, which a stale answer never removes or announces.
 */
export async function onOrgFailure(org: OrgRecord, failure: ApiFailure, inc: number | undefined): Promise<void> {
  if (failure.kind !== 'device_revoked') return;
  if (await handleDeviceRevoked(org.id, inc)) navigate({ name: 'removed', org: org.name }, { replace: true });
}

function OrgSection({ org, list, grouped }: { org: OrgRecord; list: OrgMachines | undefined; grouped: boolean }) {
  const { i18n } = useLingui();
  const [removing, setRemoving] = useState<MachineSummary | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [signInFailure, setSignInFailure] = useState<SignInFailure | null>(null);
  const refresh = useCallback(() => {
    const inc = orgIncarnation(org.id);
    void refreshMachines(org.id).then((f) => f && onOrgFailure(org, f, inc));
  }, [org]);

  async function renewSignIn() {
    setSigningIn(true);
    setSignInFailure(null);
    const outcome = await Session.signIn({ orgId: org.id, target: 'control-plane' }).catch((err: unknown): SignInFailure => ({ kind: 'rejected', code: rejectionCode(err) }));
    setSigningIn(false);
    if (outcome.kind === 'signed_in') refresh();
    else setSignInFailure(outcome);
  }

  async function open(m: MachineSummary) {
    choseMachine();
    // Remembering the machine is a convenience: it is queued, never waited for, so the open happens
    // at the tap and nothing newer can slip in between; a failure to store it is only logged.
    void updateSettings({ lastMachine: { orgId: org.id, machineId: m.id, host: m.hostname } }).catch((err: unknown) =>
      log('warn', `could not remember the last machine: ${err instanceof Error ? err.message : String(err)}`),
    );
    const opened = await openMachine(org.id, m.id);
    if (opened.ok) return;
    log('warn', `did not open a machine: ${opened.reason}${opened.reason === 'native_refused' ? ` (${opened.code})` : ''}`);
    notify('error', i18n._(openFailureMessage(opened)));
  }

  const failure = list?.state === 'failed' ? list.failure : null;
  return (
    <section aria-label={org.name} className="flex flex-col gap-2">
      {grouped && <h2 className="settings-heading mb-0">{org.name}</h2>}
      {failure?.kind === 'offline' && <Offline onRetry={refresh} />}
      {failure?.kind === 'session_expired' && (
        <div role="alert" className="state-card">
          <ShieldAlertIcon aria-hidden className="size-5 text-[var(--yaran-warning)]" />
          <p className="text-sm leading-relaxed">
            <Trans>Your sign-in to {org.name} has ended. Sign in again to see its machines.</Trans>
          </p>
          {signInFailure ? (
            <SignInResult embedded outcome={signInFailure} host={new URL(org.id).hostname} onRetry={() => void renewSignIn()} onBack={() => navigate({ name: 'orgs' })} />
          ) : (
            <Button className="min-h-12" disabled={signingIn} onClick={() => void renewSignIn()}>
              {signingIn ? <><LoaderCircleIcon aria-hidden className="motion-safe:animate-spin" /><Trans>Opening browser…</Trans></> : <Trans>Sign in</Trans>}
            </Button>
          )}
        </div>
      )}
      {failure && failure.kind !== 'offline' && failure.kind !== 'session_expired' && failure.kind !== 'device_revoked' && (
        <ErrorState failure={failure} onRetry={refresh} />
      )}
      {list?.state === 'ready' && list.machines.length === 0 && <NoMachines />}
      {list === undefined || (list.state === 'loading' && list.machines.length === 0) ? (
        <p role="status" className="text-sm text-muted-foreground">
          <Trans>Loading machines…</Trans>
        </p>
      ) : list.machines.length > 0 && (
        <ul className="settings-group flex flex-col">
          {list.machines.map((m) => (
            <MachineRow key={m.id} machine={m} onOpen={() => void open(m)} onRemove={() => setRemoving(m)} />
          ))}
        </ul>
      )}
      <RemoveMachineDialog orgId={org.id} machine={removing} onClose={() => setRemoving(null)} onFailure={(f, inc) => void onOrgFailure(org, f, inc)} />
    </section>
  );
}

export function MachineList() {
  const { i18n } = useLingui();
  const { orgs } = useStore(orgStore);
  const direct = useStore(directStore).machines;
  const lists = useStore(machinesStore);

  const refreshAll = useCallback(() => {
    for (const org of orgStore.get().orgs) {
      const inc = orgIncarnation(org.id);
      void refreshMachines(org.id).then((f) => f && onOrgFailure(org, f, inc));
    }
  }, []);

  useEffect(() => {
    refreshAll();
    return visibleInterval(refreshAll, MACHINE_POLL_MS);
  }, [refreshAll]);

  return (
    <Page
      brand
      title={<Trans>Machines</Trans>}
      actions={
        orgs.length > 0 && (
          <Button variant="ghost" size="icon-lg" className="phone-icon-button size-12 min-h-12" aria-label={i18n._(msg`Refresh machines`)} onClick={refreshAll}>
            <RefreshCwIcon aria-hidden />
          </Button>
        )
      }
    >
      {orgs.length === 0 && direct.length === 0 && <NoOrgs />}
      {orgs.map((org) => (
        <OrgSection key={org.id} org={org} list={lists[org.id]} grouped={orgs.length > 1 || direct.length > 0} />
      ))}
      {direct.length > 0 && <DirectSection machines={direct} grouped={orgs.length > 0} />}
      <Button className="min-h-12" variant="outline" onClick={() => navigate({ name: 'enter-machine' })}>
        <PlusIcon aria-hidden />
        <Trans>Add a machine</Trans>
      </Button>
    </Page>
  );
}
