/**
 * Confirm machine: the one gate every new direct machine passes, however its address arrived.
 *
 * The host comes from typing, a QR code or a `yaranapp://add-machine` link (T42), so it is
 * re-checked here, shown as a chip with a warning that links can come from anyone, and held
 * against the known-host guard (org control planes, org machine lists, direct machines) after
 * every unloaded org list has had a chance to load. Only then does `DirectCheck` probe the
 * machine and offer the explicit add, signing in natively first when a password is needed.
 *
 * - Adding writes metadata only (`direct`/`list`); the session stays in the native vault.
 *
 * <module-headers:begin>
 * Uses:
 * src/screens/onboarding/ConfirmMachine.tsx
 * ├── @yaran/protocol:src/index.ts
 * ├── @yaran/ui-kit:src/button.tsx
 * ├── @yaran/ui-kit:src/inline-code.tsx
 * ├── src/lib/directStore.ts
 * ├── src/lib/knownHosts.ts
 * ├── src/lib/notify.ts
 * ├── src/lib/route.ts
 * ├── src/screens/Page.tsx
 * └── src/screens/machines/DirectCheck.tsx
 * External: @lingui/react, react
 *
 * Used by:
 * src/screens/onboarding/ConfirmMachine.tsx
 * ├── src/App.tsx
 * ├── src/screens/machines/approval.test.tsx
 * ├── src/screens/machines/direct.test.tsx
 * └── src/screens/machines/upgradeRequired.test.tsx
 * <module-headers:end>
 */
import { Trans } from '@lingui/react/macro';
import { isPublicHost } from '@yaran/protocol';
import { Button } from '@yaran/ui-kit/button';
import { InlineCode } from '@yaran/ui-kit/inline-code';
import { useEffect, useState } from 'react';

import { addDirect, CatalogRefusal } from '../../lib/directStore.ts';
import { hostOwner, loadOrgLists, type HostOwner } from '../../lib/knownHosts.ts';
import { notify } from '../../lib/notify.ts';
import { navigate } from '../../lib/route.ts';
import { Page } from '../Page.tsx';
import { DirectCheck } from '../machines/DirectCheck.tsx';

function Owned({ owner, host }: { owner: HostOwner; host: string }) {
  const chip = <InlineCode>{host}</InlineCode>;
  return (
    <div role="alert" className="state-card">
      <p>
        {owner.kind === 'org' ? (
          <Trans>
            {chip} belongs to <InlineCode>{owner.name}</InlineCode> on this phone. Open it from that org instead.
          </Trans>
        ) : (
          <Trans>{chip} is already on this phone as a direct machine.</Trans>
        )}
      </p>
      <Button className="min-h-12" variant="outline" onClick={() => navigate({ name: 'machines' })}>
        <Trans>Go to Machines</Trans>
      </Button>
    </div>
  );
}

export function ConfirmMachine({ host }: { host: string }) {
  const valid = isPublicHost(host);
  const [owner, setOwner] = useState<HostOwner | null | 'checking'>('checking');

  useEffect(() => {
    if (!valid) return;
    let live = true;
    void loadOrgLists().then(() => live && setOwner(hostOwner(host)));
    return () => {
      live = false;
    };
  }, [host, valid]);

  if (!valid) {
    return (
      <Page title={<Trans>Add machine</Trans>} back={{ name: 'enter-machine' }}>
        <p role="alert">
          <Trans>That machine address isn't valid, so it can't be added.</Trans>
        </p>
        <Button className="min-h-12" onClick={() => navigate({ name: 'enter-machine' })}>
          <Trans>Type the machine address</Trans>
        </Button>
      </Page>
    );
  }

  async function add(instance: string | null, cancelled: () => boolean) {
    // The guard again: an org (or another screen) may have claimed the host while the sign-in was
    // out, or claim it while the save is written. Either is a refusal, never a quiet return, so
    // DirectCheck ends the sign-in this approval minted (by its own id) rather than stranding it.
    const claimed = () => {
      const now = hostOwner(host);
      if (now && !cancelled()) setOwner(now);
      return now !== null;
    };
    if (claimed()) throw new CatalogRefusal('host_owned');
    await addDirect({ host, instance }, () => cancelled() || claimed());
    if (cancelled()) return;
    notify('success', <Trans>Added <InlineCode>{host}</InlineCode>. Tap it to open.</Trans>);
    navigate({ name: 'machines' }, { replace: true });
  }

  return (
    <Page title={<Trans>Add this machine?</Trans>} back={{ name: 'enter-machine' }}>
      <p>
        <Trans>
          Address: <InlineCode>{host}</InlineCode>
        </Trans>
      </p>
      <p className="text-sm text-muted-foreground">
        <Trans>Only continue if you expected to add this machine. Links and QR codes can come from anyone.</Trans>
      </p>
      {owner === 'checking' ? (
        <p role="status" className="text-sm text-muted-foreground">
          <Trans>Checking the machine…</Trans>
        </p>
      ) : owner ? (
        <Owned owner={owner} host={host} />
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            <Trans>Direct machines don't send notifications; those come through Cloud Connect.</Trans>
          </p>
          <DirectCheck host={host} approveLabel={<Trans>Add machine</Trans>} onApproved={add} />
        </>
      )}
    </Page>
  );
}
