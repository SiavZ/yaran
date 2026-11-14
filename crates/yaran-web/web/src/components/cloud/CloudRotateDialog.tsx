/**
 * The Rotate token confirm for Yaran Cloud: the old tunnel token stops working the
 * moment the control plane issues a new one, so it always asks first.
 *
 * - Confirm family: prose plus Cancel (autofocused) and a destructive Rotate token,
 *   with misclick-safe spacing between the body and the buttons.
 * - Pure presentation: the parent `CloudDialog` runs the request on confirm.
 * - Tunnel token only; rotating the consent key is CLI-only by design.
 *
 * <module-headers:begin>
 * Uses:
 * src/components/cloud/CloudRotateDialog.tsx
 * ├── src/components/ui/button.tsx
 * ├── src/components/ui/dialog.tsx
 * └── src/components/ui/inline-code.tsx
 * External: none
 *
 * Used by:
 * src/components/cloud/CloudRotateDialog.tsx
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

export function CloudRotateDialog({
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
          <DialogTitle>Rotate the tunnel token?</DialogTitle>
          <DialogDescription>
            The control plane issues a new token for{" "}
            <InlineCode>{hostname}</InlineCode> and the old one stops working. A
            running yaran reconnects with the new token by itself.
          </DialogDescription>
        </DialogHeader>
        {/* Misclick-safe spacing between the body and the buttons. */}
        <div className="h-2" />
        <DialogFooter>
          <Button variant="outline" autoFocus onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm}>
            Rotate token
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
