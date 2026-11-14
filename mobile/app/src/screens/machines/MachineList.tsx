/**
 * Machines: every machine of every added org, grouped by org when there is more than one.
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
 * ├── src/lib/machinesStore.ts
 * ├── src/lib/native/machineView.ts
 * ├── src/lib/orgStore.ts
 * ├── src/lib/route.ts
 * ├── src/lib/settingsStore.ts
 * ├── src/lib/store.ts
 * ├── src/lib/visibleClock.ts
 * ├── src/screens/Page.tsx
 * ├── src/screens/machines/MachineRow.tsx
 * ├── src/screens/machines/RemoveMachineDialog.tsx
 * ├── src/screens/machines/states/Empty.tsx
 * ├── src/screens/machines/states/ErrorState.tsx
 * └── src/screens/machines/states/Offline.tsx
 * External: @lingui/core, @lingui/react, lucide-react, react
 *
 * Used by:
 * src/screens/machines/MachineList.tsx
 * ├── src/App.tsx
 * └── src/screens/machines/machines.test.tsx
 * <module-headers:end>
 */
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import type { MachineSummary } from '@yaran/protocol';
import { Button } from '@yaran/ui-kit/button';
import { RefreshCwIcon } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import type { ApiFailure } from '../../lib/api.ts';
import { MACHINE_POLL_MS, machinesStore, refreshMachines, type OrgMachines } from '../../lib/machinesStore.ts';
import { MachineView, Session } from '../../lib/native/machineView.ts';
import { handleDeviceRevoked, orgStore, type OrgRecord } from '../../lib/orgStore.ts';
import { navigate } from '../../lib/route.ts';
import { updateSettings } from '../../lib/settingsStore.ts';
import { useStore } from '../../lib/store.ts';
import { visibleInterval } from '../../lib/visibleClock.ts';
import { Page } from '../Page.tsx';
import { MachineRow } from './MachineRow.tsx';
import { RemoveMachineDialog } from './RemoveMachineDialog.tsx';
import { NoMachines, NoOrgs } from './states/Empty.tsx';
import { ErrorState } from './states/ErrorState.tsx';
import { Offline } from './states/Offline.tsx';

/** Routes a device_revoked answer to the phone-removed screen; other failures stay in place. */
export async function onOrgFailure(org: OrgRecord, failure: ApiFailure): Promise<void> {
  if (failure.kind !== 'device_revoked') return;
  await handleDeviceRevoked(org.id);
  navigate({ name: 'removed', org: org.name }, { replace: true });
}

function OrgSection({ org, list, grouped }: { org: OrgRecord; list: OrgMachines | undefined; grouped: boolean }) {
  const [removing, setRemoving] = useState<MachineSummary | null>(null);
  const refresh = useCallback(() => {
    void refreshMachines(org.id).then((f) => f && onOrgFailure(org, f));
  }, [org]);

  async function open(m: MachineSummary) {
    const target = { orgId: org.id, machineId: m.id, host: m.hostname };
    await updateSettings({ lastMachine: target });
    await MachineView.open(target);
  }

  const failure = list?.state === 'failed' ? list.failure : null;
  return (
    <section aria-label={org.name} className="flex flex-col gap-2">
      {grouped && <h2 className="text-sm font-semibold text-muted-foreground">{org.name}</h2>}
      {failure?.kind === 'offline' && <Offline onRetry={refresh} />}
      {failure?.kind === 'session_expired' && (
        <div role="alert" className="flex flex-col items-start gap-3 rounded-lg border border-border p-4">
          <p>
            <Trans>Your sign-in to {org.name} has ended. Sign in again to see its machines.</Trans>
          </p>
          <Button
            className="h-10"
            onClick={() => void Session.signIn({ orgId: org.id, target: 'control-plane' }).then((o) => o.kind === 'signed_in' && refresh())}
          >
            <Trans>Sign in</Trans>
          </Button>
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
      ) : (
        <ul className="flex flex-col gap-2">
          {list.machines.map((m) => (
            <MachineRow key={m.id} machine={m} onOpen={() => void open(m)} onRemove={() => setRemoving(m)} />
          ))}
        </ul>
      )}
      <RemoveMachineDialog orgId={org.id} machine={removing} onClose={() => setRemoving(null)} onFailure={(f) => void onOrgFailure(org, f)} />
    </section>
  );
}

export function MachineList() {
  const { i18n } = useLingui();
  const { orgs } = useStore(orgStore);
  const lists = useStore(machinesStore);

  const refreshAll = useCallback(() => {
    for (const org of orgStore.get().orgs) void refreshMachines(org.id).then((f) => f && onOrgFailure(org, f));
  }, []);

  useEffect(() => {
    refreshAll();
    return visibleInterval(refreshAll, MACHINE_POLL_MS);
  }, [refreshAll]);

  return (
    <Page
      title={<Trans>Machines</Trans>}
      actions={
        orgs.length > 0 && (
          <Button variant="ghost" size="icon-lg" className="size-10" aria-label={i18n._(msg`Refresh machines`)} onClick={refreshAll}>
            <RefreshCwIcon aria-hidden />
          </Button>
        )
      }
    >
      {orgs.length === 0 && <NoOrgs />}
      {orgs.map((org) => (
        <OrgSection key={org.id} org={org} list={lists[org.id]} grouped={orgs.length > 1} />
      ))}
    </Page>
  );
}
