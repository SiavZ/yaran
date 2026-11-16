/**
 * Remove machine: destructive confirm for `DELETE /v1/me/machines/{id}`.
 *
 * Removal tears down the machine's tunnel and Access app, so the dialog names the machine as
 * a chip, autofocuses Cancel, keeps misclick-safe spacing, and says that yaran on the machine
 * stops its cloud connection. The outcome is always confirmed by a toast (keyed busy → final).
 *
 * - A 404 means already gone: an info toast and a refresh. `device_revoked` removes the org.
 *
 * <module-headers:begin>
 * Uses:
 * src/screens/machines/RemoveMachineDialog.tsx
 * ├── @yaran/protocol:src/index.ts
 * ├── @yaran/ui-kit:src/button.tsx
 * ├── @yaran/ui-kit:src/dialog.tsx
 * ├── @yaran/ui-kit:src/inline-code.tsx
 * ├── src/lib/api.ts
 * ├── src/lib/machinesStore.ts
 * └── src/lib/notify.ts
 * External: @lingui/react
 *
 * Used by:
 * src/screens/machines/RemoveMachineDialog.tsx
 * └── src/screens/machines/MachineList.tsx
 * <module-headers:end>
 */
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import type { MachineSummary } from '@yaran/protocol';
import { Button } from '@yaran/ui-kit/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@yaran/ui-kit/dialog';
import { InlineCode } from '@yaran/ui-kit/inline-code';

import { failureMessage, removeMachine, type ApiFailure } from '../../lib/api.ts';
import { dropMachine, refreshMachines } from '../../lib/machinesStore.ts';
import { notify, notifyBusy } from '../../lib/notify.ts';

export function RemoveMachineDialog({
  orgId,
  machine,
  onClose,
  onFailure,
}: {
  orgId: string;
  machine: MachineSummary | null;
  onClose: () => void;
  onFailure: (failure: ApiFailure) => void;
}) {
  const { i18n } = useLingui();

  async function confirm(m: MachineSummary) {
    onClose();
    const id = `remove-machine:${m.id}`;
    const name = <InlineCode>{m.name}</InlineCode>;
    notifyBusy(id, <Trans>Removing {name}…</Trans>, <Trans>Still waiting for the control plane to confirm removing {name}. Tap Refresh on Machines to check.</Trans>);
    const got = await removeMachine(orgId, m.id);
    if (!got.ok) {
      notify('error', <Trans>Couldn't remove {name}: {i18n._(failureMessage(got.failure))}</Trans>, { id });
      onFailure(got.failure);
      return;
    }
    dropMachine(orgId, m.id);
    if (got.value === 'already_gone') {
      notify('info', <Trans>{name} was already removed.</Trans>, { id });
    } else {
      notify('success', <Trans>Removal of {name} started. yaran on that machine stops its cloud connection.</Trans>, { id });
    }
    void refreshMachines(orgId);
  }

  return (
    <Dialog open={machine !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent showCloseButton={false} destructive>
        <DialogHeader>
          <DialogTitle>
            <Trans>
              Remove <InlineCode>{machine?.name ?? ''}</InlineCode>?
            </Trans>
          </DialogTitle>
        </DialogHeader>
        <p className="text-sm text-destructive">
          <Trans>
            This deletes the machine's tunnel and sign-in app in your org. yaran on <InlineCode>{machine?.name ?? ''}</InlineCode>{' '}
            stops its cloud connection; run <InlineCode>yaran cloud login</InlineCode> there to add it again.
          </Trans>
        </p>
        <div className="h-2" />
        <DialogFooter>
          <Button className="h-10" variant="outline" autoFocus onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button className="h-10" variant="destructive" onClick={() => machine && void confirm(machine)}>
            <Trans>Remove machine</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
