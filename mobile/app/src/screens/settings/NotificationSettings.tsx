/**
 * Notifications section of Settings: Phase 16's push rows, one per org that offers push.
 *
 * Renders `NotificationSettingsSection` from the last reconcile answers in `pushStore`,
 * reconciles every org when it opens, lists the UnifiedPush distributors on Android, and asks
 * before turning an org's notifications off (a destructive confirm).
 *
 * - Seam: this file is the only place Settings learns about push.
 *
 * <module-headers:begin>
 * Uses:
 * src/screens/settings/NotificationSettings.tsx
 * ├── @yaran/push:src/index.ts
 * ├── @yaran/ui-kit:src/button.tsx
 * ├── @yaran/ui-kit:src/dialog.tsx
 * ├── src/lib/machinesStore.ts
 * ├── src/lib/orgStore.ts
 * ├── src/lib/store.ts
 * ├── src/push/NotificationSettingsSection.tsx
 * ├── src/push/pushDeps.ts
 * ├── src/push/pushStrings.ts
 * └── src/push/pushWiring.ts
 * External: @capacitor/core, @lingui/react, react
 *
 * Used by:
 * src/screens/settings/NotificationSettings.tsx
 * └── src/screens/settings/Settings.tsx
 * <module-headers:end>
 */
import { Capacitor } from '@capacitor/core';
import { Trans } from '@lingui/react/macro';
import { Push, type DistributorList } from '@yaran/push';
import { Button } from '@yaran/ui-kit/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@yaran/ui-kit/dialog';
import { useEffect, useState } from 'react';

import { machinesStore } from '../../lib/machinesStore.ts';
import { findOrg, orgStore, type OrgRecord } from '../../lib/orgStore.ts';
import { useStore } from '../../lib/store.ts';
import { NotificationSettingsSection, type NotificationOrgRow } from '../../push/NotificationSettingsSection.tsx';
import { pushStore } from '../../push/pushDeps.ts';
import { pushText } from '../../push/pushStrings.ts';
import { mutePushMachine, mutePushOrg, pushAction, reconcileAllPush, selectDistributor, turnOffPush } from '../../push/pushWiring.ts';

export function NotificationSettings() {
  const results = useStore(pushStore);
  const { orgs } = useStore(orgStore);
  const machines = useStore(machinesStore);
  const [distributors, setDistributors] = useState<DistributorList | null>(null);
  const [turningOff, setTurningOff] = useState<OrgRecord | null>(null);

  useEffect(() => {
    reconcileAllPush();
    if (Capacitor.getPlatform() === 'android') void Push.listDistributors().then(setDistributors, () => setDistributors(null));
  }, []);

  const rows: NotificationOrgRow[] = orgs.flatMap((org) => {
    const r = results[org.id];
    if (r?.kind !== 'row') return [];
    const muted = r.device?.muted_machine_ids ?? [];
    const list = (machines[org.id]?.machines ?? []).map((m) => ({ id: m.id, name: m.name, muted: muted.includes(m.id) }));
    return [{ orgId: org.id, orgName: org.name, state: r.state, machines: list }];
  });

  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        <Trans>None of your orgs offers notifications yet.</Trans>
      </p>
    );
  }
  return (
    <>
      <NotificationSettingsSection
        rows={rows}
        distributors={distributors}
        t={pushText}
        onAction={(orgId, action) => void pushAction(orgId, action)}
        onTurnOff={(orgId) => setTurningOff(findOrg(orgId) ?? null)}
        onMuteOrg={(orgId, mode) => void mutePushOrg(orgId, mode)}
        onMuteMachine={(orgId, machineId, muted) => void mutePushMachine(orgId, machineId, muted)}
        onSelectDistributor={(name) => void selectDistributor(name)}
      />
      <Dialog open={turningOff !== null} onOpenChange={(open) => !open && setTurningOff(null)}>
        <DialogContent showCloseButton={false} destructive>
          <DialogHeader>
            <DialogTitle>{pushText('push.confirm.turn_off.title', { name: turningOff?.name ?? '' })}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-destructive">{pushText('push.confirm.turn_off.body', { name: turningOff?.name ?? '' })}</p>
          <div className="h-2" />
          <DialogFooter>
            <Button className="h-10" variant="outline" autoFocus onClick={() => setTurningOff(null)}>
              <Trans>Cancel</Trans>
            </Button>
            <Button
              className="h-10"
              variant="destructive"
              onClick={() => {
                if (turningOff) void turnOffPush(turningOff);
                setTurningOff(null);
              }}
            >
              <Trans>Turn off</Trans>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
