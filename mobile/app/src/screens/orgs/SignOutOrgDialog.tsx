/**
 * Sign out of an org: destructive confirm.
 *
 * Signing out revokes this phone's device record in the org (sent by Phase 15's native client
 * through Phase 16's hook), deletes every session, cookie and the install id for the org's
 * hosts (`Session.signOut`), and removes the org's local data. Cancel is autofocused; the org
 * is named as a chip; the outcome is confirmed by a toast.
 *
 * <module-headers:begin>
 * Uses:
 * src/screens/orgs/SignOutOrgDialog.tsx
 * ├── @yaran/ui-kit:src/button.tsx
 * ├── @yaran/ui-kit:src/dialog.tsx
 * ├── @yaran/ui-kit:src/inline-code.tsx
 * ├── src/lib/notify.ts
 * └── src/lib/orgStore.ts
 * External: @lingui/react
 *
 * Used by:
 * src/screens/orgs/SignOutOrgDialog.tsx
 * └── src/screens/orgs/OrgList.tsx
 * <module-headers:end>
 */
import { Trans } from '@lingui/react/macro';
import { Button } from '@yaran/ui-kit/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@yaran/ui-kit/dialog';
import { InlineCode } from '@yaran/ui-kit/inline-code';

import { notify } from '../../lib/notify.ts';
import { signOutOrg, type OrgRecord } from '../../lib/orgStore.ts';

export function SignOutOrgDialog({ org, onClose }: { org: OrgRecord | null; onClose: () => void }) {
  async function confirm(o: OrgRecord) {
    onClose();
    const name = <InlineCode>{o.name}</InlineCode>;
    try {
      await signOutOrg(o.id);
      notify('success', <Trans>Signed out of {name} and removed it from this phone.</Trans>);
    } catch {
      notify('error', <Trans>Couldn't sign out of {name}. Check your connection and try again.</Trans>);
    }
  }

  return (
    <Dialog open={org !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent showCloseButton={false} destructive>
        <DialogHeader>
          <DialogTitle>
            <Trans>
              Sign out of <InlineCode>{org?.name ?? ''}</InlineCode>?
            </Trans>
          </DialogTitle>
        </DialogHeader>
        <p className="text-sm text-destructive">
          <Trans>
            This phone is removed from <InlineCode>{org?.name ?? ''}</InlineCode> and its sign-ins there are deleted. You
            can add the org again later.
          </Trans>
        </p>
        <div className="h-2" />
        <DialogFooter>
          <Button className="h-10" variant="outline" autoFocus onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button className="h-10" variant="destructive" onClick={() => org && void confirm(org)}>
            <Trans>Sign out</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
