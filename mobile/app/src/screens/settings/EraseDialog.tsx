/**
 * Erase everything on this phone: destructive confirm.
 *
 * Signs out of every org (each one through Phase 15's `Session.signOut`), then erases the
 * vault and deletes its keys. Cancel is autofocused; the outcome is confirmed by a toast.
 *
 * <module-headers:begin>
 * Uses:
 * src/screens/settings/EraseDialog.tsx
 * ├── @yaran/ui-kit:src/button.tsx
 * ├── @yaran/ui-kit:src/dialog.tsx
 * ├── src/lib/notify.ts
 * └── src/lib/orgStore.ts
 * External: @lingui/react
 *
 * Used by:
 * src/screens/settings/EraseDialog.tsx
 * └── src/screens/settings/Settings.tsx
 * <module-headers:end>
 */
import { Trans } from '@lingui/react/macro';
import { Button } from '@yaran/ui-kit/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@yaran/ui-kit/dialog';

import { notify } from '../../lib/notify.ts';
import { eraseEverything } from '../../lib/orgStore.ts';

export function EraseDialog({ open, onClose, onErased }: { open: boolean; onClose: () => void; onErased: () => void }) {
  async function confirm() {
    onClose();
    try {
      await eraseEverything();
      notify('success', <Trans>Everything yaran kept on this phone was erased.</Trans>);
      onErased();
    } catch {
      notify('error', <Trans>Erasing failed partway. Try again, or uninstall the app to remove everything.</Trans>, { sticky: true });
    }
  }
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent showCloseButton={false} destructive>
        <DialogHeader>
          <DialogTitle>
            <Trans>Erase everything on this phone?</Trans>
          </DialogTitle>
        </DialogHeader>
        <p className="text-sm text-destructive">
          <Trans>
            This signs the phone out of every org, removes every org and setting, and deletes the keys that protect them. You'll
            have to add your orgs again.
          </Trans>
        </p>
        <div className="h-2" />
        <DialogFooter>
          <Button className="h-10" variant="outline" autoFocus onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button className="h-10" variant="destructive" onClick={() => void confirm()}>
            <Trans>Erase everything</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
