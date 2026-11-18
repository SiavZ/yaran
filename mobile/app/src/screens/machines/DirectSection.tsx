/**
 * The Direct section of Machines: machines this phone reaches over HTTPS without Cloud Connect.
 *
 * Each row opens the machine (all its approved routes, through `openDirect`) and carries a
 * `⋯` menu with Open, Sign in again… (the native password sheet), Ways to reach it… and
 * Remove… (a destructive confirm that signs out natively, then forgets the record).
 *
 * - The label and host are user data and render as React text or chips.
 * - Direct machines get no push; the section says so once.
 *
 * <module-headers:begin>
 * Uses:
 * src/screens/machines/DirectSection.tsx
 * ├── @yaran/ui-kit:src/button.tsx
 * ├── @yaran/ui-kit:src/dialog.tsx
 * ├── @yaran/ui-kit:src/dropdown-menu.tsx
 * ├── @yaran/ui-kit:src/inline-code.tsx
 * ├── src/lib/diagnostics.ts
 * ├── src/lib/directStore.ts
 * ├── src/lib/native/machineView.ts
 * ├── src/lib/notify.ts
 * ├── src/lib/openMachine.ts
 * ├── src/lib/route.ts
 * ├── src/lib/settingsStore.ts
 * └── src/screens/machines/directText.tsx
 * External: @lingui/core, @lingui/react, lucide-react, react
 *
 * Used by:
 * src/screens/machines/DirectSection.tsx
 * ├── src/screens/machines/InstanceChangedDialog.tsx
 * └── src/screens/machines/MachineList.tsx
 * <module-headers:end>
 */
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { Button } from '@yaran/ui-kit/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@yaran/ui-kit/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@yaran/ui-kit/dropdown-menu';
import { InlineCode } from '@yaran/ui-kit/inline-code';
import { EllipsisIcon, ExternalLinkIcon, KeyRoundIcon, RouteIcon, Trash2Icon } from 'lucide-react';
import { useRef, useState } from 'react';

import { log } from '../../lib/diagnostics.ts';
import { directHosts, findDirect, removeDirect, withHost, type DirectRecord } from '../../lib/directStore.ts';
import { Session, type DirectSignInOutcome } from '../../lib/native/machineView.ts';
import { notify } from '../../lib/notify.ts';
import { choseMachine, openDirect, openFailureMessage, rejectionCode } from '../../lib/openMachine.ts';
import { navigate } from '../../lib/route.ts';
import { updateSettings } from '../../lib/settingsStore.ts';
import { signInFailureText, type SignInFailure } from './directText.tsx';

export async function openDirectMachine(record: DirectRecord): Promise<void> {
  choseMachine();
  // Remembering the machine is a convenience: queued, never waited for (see MachineList's open).
  void updateSettings({ lastMachine: { directId: record.id } }).catch((err: unknown) =>
    log('warn', `could not remember the last machine: ${err instanceof Error ? err.message : String(err)}`),
  );
  const opened = await openDirect(record.id);
  if (opened.ok) return;
  log('warn', `did not open a direct machine: ${opened.reason}${opened.reason === 'native_refused' ? ` (${opened.code})` : ''}`);
  notify('error', i18n._(openFailureMessage(opened)));
}

async function signInAgain(id: string, host: string): Promise<void> {
  const chip = <InlineCode>{host}</InlineCode>;
  // One same-host turn: never alongside another sign-in, sign-out or erase on this host. A
  // Remove ahead of it in the turn order may have forgotten the machine: then nothing signs in,
  // because a session with no machine listed for it could never be removed.
  const out = await withHost(host, async (): Promise<DirectSignInOutcome | { kind: 'gone' }> => {
    const current = findDirect(id);
    if (!current || !directHosts(current).includes(host)) return { kind: 'gone' };
    return Session.directSignIn({ host });
  }).catch((err: unknown): SignInFailure => ({ kind: 'rejected', code: rejectionCode(err) }));
  switch (out.kind) {
    case 'gone':
      return notify('info', <Trans>{chip} was removed from this phone, so nothing was signed in.</Trans>);
    case 'signed_in':
      return notify('success', <Trans>Signed in to {chip}.</Trans>);
    case 'not_required':
      return notify('info', <Trans>{chip} lets this network in without a password, so there is nothing to sign in to.</Trans>);
    case 'cancelled':
      return;
    default:
      return notify('error', signInFailureText(out, host).text);
  }
}

function RemoveDirectDialog({ record, onClose }: { record: DirectRecord | null; onClose: () => void }) {
  async function confirm(r: DirectRecord) {
    onClose();
    const name = <InlineCode>{r.label}</InlineCode>;
    const out = await removeDirect(r.id);
    switch (out.kind) {
      case 'removed':
        return notify(
          'success',
          out.serverEnded ? (
            <Trans>Removed {name} and ended this phone's sign-in on it.</Trans>
          ) : (
            <Trans>Removed {name} from this phone. The machine didn't confirm ending the sign-in; Sign out in its web page ends every sign-in.</Trans>
          ),
        );
      case 'vault_locked':
        return notify('error', <Trans>Unlock the app, then remove {name} again.</Trans>);
      case 'failed': {
        const code = <InlineCode>{out.code}</InlineCode>;
        return notify(
          'error',
          out.signedOut ? (
            <Trans>This phone signed out of {name}, but couldn't forget it ({code}). It is still listed; try again.</Trans>
          ) : (
            <Trans>Couldn't remove {name} ({code}). It is still on this phone; try again.</Trans>
          ),
        );
      }
    }
  }
  const label = <InlineCode>{record?.label ?? ''}</InlineCode>;
  return (
    <Dialog open={record !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent showCloseButton={false} destructive>
        <DialogHeader>
          <DialogTitle>
            <Trans>Remove {label}?</Trans>
          </DialogTitle>
        </DialogHeader>
        <p className="text-sm">
          <Trans>This phone signs out of {label} and forgets it and its ways to reach it. yaran on the machine keeps running; you can add it again later.</Trans>
        </p>
        <div className="h-2" />
        <DialogFooter>
          <Button className="min-h-12" variant="outline" autoFocus onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button className="min-h-12" variant="destructive" onClick={() => record && void confirm(record)}>
            <Trans>Remove machine</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DirectRow({ record, onRemove }: { record: DirectRecord; onRemove: () => void }) {
  const { i18n: ui } = useLingui();
  // Remove… opens a dialog whose Cancel takes focus; the closing menu must not pull it back.
  const dialogNext = useRef(false);
  const open = () => void openDirectMachine(record);
  const ways = record.routes.length;
  return (
    <li className="flex min-h-14 items-center gap-3 rounded-xl border border-border bg-card p-4">
      <button type="button" className="flex min-h-12 min-w-0 flex-1 flex-col items-start gap-1 [overflow-wrap:anywhere] text-left" onClick={open}>
        <span className="font-medium">{record.label}</span>
        <span className="text-sm text-muted-foreground">{ways > 1 ? ui._(msg`Direct · ${ways} ways to reach it`) : ui._(msg`Direct`)}</span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger
          onClick={() => (dialogNext.current = false)}
          render={
            <button
              type="button"
              aria-label={ui._(msg`Actions for ${record.label}`)}
              className="phone-icon-button flex size-12 min-h-12 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            />
          }
        >
          <EllipsisIcon className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" finalFocus={() => !dialogNext.current}>
          <DropdownMenuItem onClick={open}>
            <ExternalLinkIcon />
            {ui._(msg`Open`)}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => void signInAgain(record.id, record.host)}>
            <KeyRoundIcon />
            {ui._(msg`Sign in again…`)}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => navigate({ name: 'machine-routes', id: record.id })}>
            <RouteIcon />
            {ui._(msg`Ways to reach it…`)}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => {
              dialogNext.current = true;
              onRemove();
            }}
          >
            <Trash2Icon />
            {ui._(msg`Remove…`)}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

export function DirectSection({ machines, grouped }: { machines: DirectRecord[]; grouped: boolean }) {
  const [removing, setRemoving] = useState<DirectRecord | null>(null);
  return (
    <section aria-labelledby="direct-machines" className="flex flex-col gap-2">
      <h2 id="direct-machines" className={grouped ? 'text-sm font-semibold text-muted-foreground' : 'sr-only'}>
        <Trans>Direct</Trans>
      </h2>
      <p className="text-sm text-muted-foreground">
        <Trans>Reached over HTTPS without Cloud Connect. They don't send notifications.</Trans>
      </p>
      <ul className="flex flex-col gap-2">
        {machines.map((m) => (
          <DirectRow key={m.id} record={m} onRemove={() => setRemoving(m)} />
        ))}
      </ul>
      <RemoveDirectDialog record={removing} onClose={() => setRemoving(null)} />
    </section>
  );
}
