/**
 * A direct machine's window closed with `instance_changed`: a different yaran now answers at
 * one of its addresses. The record and route come from the close event's own context (see
 * `instanceChangedTarget`); a close without a trusted context never reaches this dialog. The user decides: Remove (signs out natively and forgets it), Keep (checks
 * the host again, records the instance it reports now, and opens it again), or Not now
 * (autofocused, changes nothing).
 *
 * - Nothing is rewritten without the press; Keep re-reads the instance on that route with
 *   `routeStatus` (its own credential only) rather than trusting anything from the window.
 *
 * <module-headers:begin>
 * Uses:
 * src/screens/machines/InstanceChangedDialog.tsx
 * ├── @yaran/ui-kit:src/button.tsx
 * ├── @yaran/ui-kit:src/dialog.tsx
 * ├── @yaran/ui-kit:src/inline-code.tsx
 * ├── src/lib/directStore.ts
 * ├── src/lib/native/machineView.ts
 * ├── src/lib/notify.ts
 * ├── src/lib/openMachine.ts
 * ├── src/screens/machines/DirectSection.tsx
 * └── src/screens/machines/directText.tsx
 * External: @lingui/react, react
 *
 * Used by:
 * src/screens/machines/InstanceChangedDialog.tsx
 * └── src/App.tsx
 * <module-headers:end>
 */
import { Trans } from '@lingui/react/macro';
import { Button } from '@yaran/ui-kit/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@yaran/ui-kit/dialog';
import { InlineCode } from '@yaran/ui-kit/inline-code';
import { useEffect, useRef } from 'react';

import { CatalogRefusal, findDirect, removeDirect, updateDirect, type DirectRecord } from '../../lib/directStore.ts';
import { Session } from '../../lib/native/machineView.ts';
import { notify } from '../../lib/notify.ts';
import { choseMachine, currentRoute, machineChoices, rejectionCode, type ChangedTarget } from '../../lib/openMachine.ts';
import { probeFailureText, type ProbeFailure } from './directText.tsx';
import { openDirectMachine } from './DirectSection.tsx';

const stale = (
  <Trans>That way to reach the machine changed while the app was checking it, so nothing was saved. Open the machine again to check it.</Trans>
);

// Re-reads what answers now on the route that changed, with that route's own credential only.
// The route is resolved again (an org machine may have a new host, or be gone) before the probe
// and once more inside the queued write; an answer for a host that is no longer the route is
// never saved.
// `owned` is the press's own claim: the App still up, the address unchanged, and no newer machine
// chosen (a list or notification Open, an agent link). Without it nothing more is saved, said or opened.
async function keep({ id, route, instance: confirmed }: ChangedTarget, owned: () => boolean): Promise<void> {
  const record = findDirect(id);
  const now = record && record.instance === confirmed ? currentRoute(record, route) : undefined;
  if (!record || !now) return notify('error', stale);
  // Still the route this Keep was about: the same host for it, and the identity it replaces.
  const unchanged = (current: DirectRecord | undefined) => current?.instance === confirmed && currentRoute(current, route)?.host === now.host;
  const status = await Session.routeStatus({ route: now }).catch((err: unknown): ProbeFailure => ({ kind: 'rejected', code: rejectionCode(err) }));
  if (!owned()) return;
  if (status.kind === 'sign_in_required') {
    return notify('error', <Trans>Sign in to <InlineCode>{now.host}</InlineCode> again, then open the machine to check it.</Trans>);
  }
  if (status.kind !== 'yaran') return notify('error', probeFailureText(status, now.host).text);
  let saved;
  try {
    saved = await updateDirect(
      id,
      (current) => {
        if (!owned()) throw new CatalogRefusal('abandoned');
        if (!unchanged(current)) throw new CatalogRefusal('stale');
        return { instance: status.instance };
      },
      // Checked again once written: an org remap, or the person moving on, while the write was out undoes it.
      () => !owned() || !unchanged(findDirect(id)),
    );
  } catch (err) {
    const code = <InlineCode>{rejectionCode(err)}</InlineCode>;
    if (err instanceof CatalogRefusal && err.code === 'rollback_failed') {
      const name = <InlineCode>{record.label}</InlineCode>;
      return notify('error', <Trans>The app couldn't undo the identity change for {name} ({code}). The new identity is still saved; check it before opening the machine again.</Trans>);
    }
    if (!owned()) return;
    if (err instanceof CatalogRefusal && ['stale', 'gone', 'abandoned'].includes(err.code)) return notify('error', stale);
    return notify('error', <Trans>The app couldn't save the new identity ({code}). Try again.</Trans>);
  }
  // The last check before the native open: `openDirectMachine` waits on nothing before it.
  if (!owned()) return;
  await openDirectMachine(saved);
}

async function remove(id: string, label: string): Promise<void> {
  const name = <InlineCode>{label}</InlineCode>;
  const out = await removeDirect(id);
  if (out.kind === 'removed') notify('success', <Trans>Removed {name} from this phone.</Trans>);
  else if (out.kind === 'vault_locked') notify('error', <Trans>Unlock the app, then remove {name} again.</Trans>);
  else if (out.signedOut) notify('error', <Trans>This phone signed out of {name}, but couldn't forget it (<InlineCode>{out.code}</InlineCode>). It is still listed; try again.</Trans>);
  else notify('error', <Trans>Couldn't remove {name} (<InlineCode>{out.code}</InlineCode>). It is still on this phone; try again.</Trans>);
}

export function InstanceChangedDialog({ target, onClose }: { target: ChangedTarget | null; onClose: () => void }) {
  const record = target === null ? undefined : findDirect(target.id);
  // The dialog lives as long as the App: its lifetime is the App's, for a Keep still running.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const host = <InlineCode>{target?.route.host ?? ''}</InlineCode>;
  return (
    <Dialog open={record !== undefined} onOpenChange={(open) => !open && onClose()}>
      <DialogContent showCloseButton={false} destructive>
        <DialogHeader>
          <DialogTitle>
            <Trans>A different yaran answers at {host}</Trans>
          </DialogTitle>
        </DialogHeader>
        <p className="text-sm">
          <Trans>
            The machine at {host} isn't <InlineCode>{record?.label ?? ''}</InlineCode>, the one this phone added. If you reinstalled or reset yaran there, keep it. If you didn't expect this, remove it.
          </Trans>
        </p>
        <div className="h-2" />
        <DialogFooter>
          <Button className="min-h-12" variant="outline" autoFocus onClick={onClose}>
            <Trans>Not now</Trans>
          </Button>
          <Button
            className="min-h-12"
            variant="outline"
            onClick={() => {
              onClose();
              if (!record || !target) return;
              // A choice at the press: an automatic reopen still waiting gives way, whatever the check finds.
              choseMachine();
              const from = window.location.hash;
              const choices = machineChoices();
              void keep(target, () => mounted.current && window.location.hash === from && machineChoices() === choices);
            }}
          >
            <Trans>Keep and open</Trans>
          </Button>
          <Button
            className="min-h-12"
            variant="destructive"
            onClick={() => {
              onClose();
              if (record) void remove(record.id, record.label);
            }}
          >
            <Trans>Remove machine</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
