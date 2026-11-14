/**
 * The Disconnect confirm for Yaran Cloud: unpairing removes this machine from the
 * organization and deletes its credentials, so it always asks first.
 *
 * - Confirm family: prose plus Cancel (autofocused) and a destructive Disconnect,
 *   with misclick-safe spacing between the body and the buttons.
 * - Pure presentation: the parent `CloudDialog` runs the request on confirm.
 *
 * <module-headers:begin>
 * Uses:
 * src/components/cloud/CloudLogoutDialog.tsx
 * ├── src/components/ui/button.tsx
 * ├── src/components/ui/dialog.tsx
 * └── src/components/ui/inline-code.tsx
 * External: none
 *
 * Used by:
 * src/components/cloud/CloudLogoutDialog.tsx
 * └── src/components/cloud/CloudDialog.tsx
 * <module-headers:end>
 */

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { InlineCode } from "@/components/ui/inline-code"

export function CloudLogoutDialog({
  open,
  hostname,
  onCancel,
  onConfirm,
}: {
  open: boolean
  hostname: string
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent showCloseButton={false} destructive>
        <DialogHeader>
          <DialogTitle>Disconnect from Yaran Cloud?</DialogTitle>
          <DialogDescription>
            The control plane removes <InlineCode>{hostname}</InlineCode> and
            yaran deletes this machine&apos;s credentials. Phones lose access to
            it until you connect again.
          </DialogDescription>
        </DialogHeader>
        {/* Misclick-safe spacing between the body and the buttons. */}
        <div className="h-2" />
        <DialogFooter>
          <Button variant="outline" autoFocus onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm}>
            Disconnect
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
