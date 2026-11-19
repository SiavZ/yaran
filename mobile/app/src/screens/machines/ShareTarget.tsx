/**
 * Share target (G5): "Send N files to…" every org machine and direct machine on this phone.
 *
 * The count comes from `MachineView.shareStatus` (re-read on entry; the `shareReceived` event
 * updates the same store), never from a file list: the shell sees no URI, name or byte.
 * Picking a machine opens it with the batch of the share on screen (`shareBatch`); native then
 * offers the files only inside the page's own file chooser, where the web keeps ownership,
 * upload and its toast. Cancel discards that batch natively. The batch is an opaque, non-secret
 * id: it names a share, never a file.
 *
 * - A `no_share` refusal means the files are gone (opened elsewhere or discarded); the screen
 *   re-reads the status and says so, rather than reporting a generic failure.
 * - A `share_changed` refusal means a newer share replaced the one on screen before native ran
 *   the command: nothing was sent or discarded, and the screen shows the newer files.
 * - Org lists that never loaded are loaded here, so their machines can be picked.
 *
 * <module-headers:begin>
 * Uses:
 * src/screens/machines/ShareTarget.tsx
 * ├── @yaran/ui-kit:src/button.tsx
 * ├── @yaran/ui-kit:src/inline-code.tsx
 * ├── src/lib/diagnostics.ts
 * ├── src/lib/directStore.ts
 * ├── src/lib/knownHosts.ts
 * ├── src/lib/machinesStore.ts
 * ├── src/lib/native/machineView.ts
 * ├── src/lib/notify.ts
 * ├── src/lib/openMachine.ts
 * ├── src/lib/orgStore.ts
 * ├── src/lib/route.ts
 * ├── src/lib/share.ts
 * ├── src/lib/store.ts
 * └── src/screens/Page.tsx
 * External: @lingui/core, @lingui/react, react
 *
 * Used by:
 * src/screens/machines/ShareTarget.tsx
 * ├── src/App.tsx
 * └── src/screens/machines/direct.test.tsx
 * <module-headers:end>
 */
import { i18n } from '@lingui/core';
import { Plural, Trans } from '@lingui/react/macro';
import { Button } from '@yaran/ui-kit/button';
import { InlineCode } from '@yaran/ui-kit/inline-code';
import { useEffect, useRef, useState } from 'react';

import { log } from '../../lib/diagnostics.ts';
import { directStore } from '../../lib/directStore.ts';
import { loadOrgLists } from '../../lib/knownHosts.ts';
import { machinesStore } from '../../lib/machinesStore.ts';
import { MachineView } from '../../lib/native/machineView.ts';
import { notify } from '../../lib/notify.ts';
import { choseMachine, openDirect, openFailureMessage, openMachine, rejectionCode, type OpenMachineResult } from '../../lib/openMachine.ts';
import { orgStore } from '../../lib/orgStore.ts';
import { navigate } from '../../lib/route.ts';
import { refreshShare, setShare, shareArrivals, shareStore } from '../../lib/share.ts';
import { useStore } from '../../lib/store.ts';
import { Page } from '../Page.tsx';

export function ShareTarget() {
  const status = useStore(shareStore);
  const { orgs } = useStore(orgStore);
  const lists = useStore(machinesStore);
  const direct = useStore(directStore).machines;
  const [busy, setBusy] = useState(false);

  // This screen's own lifetime: a command's reply lands after the person may have moved on (a
  // link, Settings, teardown); what it shows or where it goes is then no longer this screen's.
  const shown = useRef(false);
  useEffect(() => {
    shown.current = true;
    void refreshShare();
    void loadOrgLists();
    return () => {
      shown.current = false;
    };
  }, []);

  /**
   * After native acted on `batch` (sent or discarded it), the share state forgets it only while
   * nothing newer is known: no share arrived since the press, and no other batch is shown (a
   * status read can find one before its event). Otherwise native is asked what is held now.
   * Resolves whether this press's share was still the one known.
   */
  function forget(batch: string, at: number): boolean {
    const now = shareStore.get();
    if (shareArrivals() !== at || (now?.kind === 'pending' && now.batch !== batch)) {
      void refreshShare();
      return false;
    }
    setShare({ kind: 'none' });
    return true;
  }

  /**
   * Whether this command's screen is still where the person is: mounted, and still at the address
   * it was pressed on. A link moves the address at once, before React unmounts anything, so both
   * are asked before every screen effect (busy, toast, navigation) after an await.
   */
  function pressedHere(): () => boolean {
    const from = window.location.hash;
    return () => shown.current && window.location.hash === from;
  }

  // Native ran nothing: a newer share took the place of the one on screen. Show what is held now.
  async function changed(what: 'send' | 'discard', here: () => boolean) {
    await refreshShare();
    if (!here()) return;
    notify(
      'info',
      what === 'send' ? (
        <Trans>Newer shared files arrived before these were sent, so nothing was sent. Pick a machine for the files waiting now.</Trans>
      ) : (
        <Trans>Newer shared files arrived before these were discarded, so nothing was discarded. The newer files are still waiting.</Trans>
      ),
    );
  }

  // `batch` is the share this screen showed at the press; native acts on that batch only.
  async function send(batch: string, open: (shareBatch: string) => Promise<OpenMachineResult>) {
    const at = shareArrivals();
    const here = pressedHere();
    // Picking a machine is a choice, made now: a startup reopen still waiting gives way to it.
    choseMachine();
    setBusy(true);
    const opened = await open(batch);
    if (here()) setBusy(false);
    if (opened.ok) {
      if (forget(batch, at) && here()) navigate({ name: 'machines' }, { replace: true });
      return;
    }
    if (opened.reason === 'native_refused' && opened.code === 'share_changed') return changed('send', here);
    if (opened.reason === 'native_refused' && opened.code === 'no_share') {
      await refreshShare();
      // Native said this batch is not held: a status read that failed or raced still showing it
      // is corrected. Said only about this press's files, decided after the last await: a newer
      // share's state speaks for itself.
      if (forget(batch, at) && here()) notify('warning', <Trans>Those shared files are no longer waiting. Share them to yaran again.</Trans>);
      return;
    }
    log('warn', `did not open a machine for a share: ${opened.reason}`);
    if (here()) notify('error', i18n._(openFailureMessage(opened)));
  }

  async function discard(batch: string) {
    const at = shareArrivals();
    const here = pressedHere();
    try {
      await MachineView.discardShare({ batch });
    } catch (err) {
      if (rejectionCode(err) === 'share_changed') return changed('discard', here);
      const code = <InlineCode>{rejectionCode(err)}</InlineCode>;
      if (here()) notify('error', <Trans>The app couldn't discard the shared files ({code}). Try again.</Trans>);
      return;
    }
    if (!forget(batch, at) || !here()) return;
    notify('info', <Trans>Discarded the shared files. Nothing was sent.</Trans>);
    navigate({ name: 'machines' }, { replace: true });
  }

  if (status?.kind !== 'pending') {
    return (
      <Page title={<Trans>Share to a machine</Trans>} back={{ name: 'machines' }}>
        <p role="status" className="text-muted-foreground">
          {status === null ? <Trans>Checking for shared files…</Trans> : <Trans>No shared files are waiting.</Trans>}
        </p>
      </Page>
    );
  }

  const { count, batch } = status;
  const orgMachines = orgs.flatMap((o) => (lists[o.id]?.machines ?? []).filter((m) => m.status !== 'tearing_down').map((m) => ({ org: o, m })));
  const loading = orgs.some((o) => lists[o.id] === undefined || (lists[o.id]!.state === 'loading' && lists[o.id]!.machines.length === 0));
  return (
    <Page title={<Plural value={count} one="Send # file to…" other="Send # files to…" />}>
      <p className="text-sm leading-relaxed text-muted-foreground">
        <Trans>Pick the machine, open the agent, then choose Attach a file. The app offers these files there and sends nothing before that.</Trans>
      </p>
      {loading && (
        <p role="status" className="text-sm text-muted-foreground">
          <Trans>Loading machines…</Trans>
        </p>
      )}
      <ul className="flex flex-col gap-2">
        {orgMachines.map(({ org, m }) => (
          <li key={`${org.id} ${m.id}`}>
            <Button className="min-h-14 w-full justify-start [overflow-wrap:anywhere]" variant="outline" disabled={busy} onClick={() => void send(batch, (shareBatch) => openMachine(org.id, m.id, { shareBatch }))}>
              {orgs.length > 1 ? (
                <Trans>
                  {m.name} in {org.name}
                </Trans>
              ) : (
                m.name
              )}
            </Button>
          </li>
        ))}
        {direct.map((d) => (
          <li key={d.id}>
            <Button className="min-h-14 w-full justify-start [overflow-wrap:anywhere]" variant="outline" disabled={busy} onClick={() => void send(batch, (shareBatch) => openDirect(d.id, { shareBatch }))}>
              {d.label}
            </Button>
          </li>
        ))}
      </ul>
      {!loading && orgMachines.length === 0 && direct.length === 0 && (
        <p className="text-muted-foreground">
          <Trans>No machine is on this phone yet. Add one, then share again.</Trans>
        </p>
      )}
      <Button className="min-h-12" variant="ghost" disabled={busy} onClick={() => void discard(batch)}>
        <Trans>Cancel and discard</Trans>
      </Button>
    </Page>
  );
}
