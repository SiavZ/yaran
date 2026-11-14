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
 * ├── @yaran/ui-kit:src/button.tsx
 * ├── @yaran/ui-kit:src/dialog.tsx
 * └── @yaran/ui-kit:src/inline-code.tsx
 * External: react
 *
 * Used by:
 * src/components/cloud/CloudRotateDialog.tsx
 * └── src/components/cloud/CloudDialog.tsx
 * <module-headers:end>
 */

import { useRef } from "react"

import { Button } from "@yaran/ui-kit/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@yaran/ui-kit/dialog"
import { InlineCode } from "@yaran/ui-kit/inline-code"

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
  const cancel = useRef<HTMLButtonElement>(null)
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      {/* Cancel is focused through Base UI's focus queue, not autoFocus: an
          autoFocused element makes the confirm queue nothing, so the parent Cloud
          dialog's still-pending first-focus frame would move focus off Cancel. */}
      <DialogContent showCloseButton={false} destructive initialFocus={cancel}>
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
          <Button ref={cancel} variant="outline" onClick={onCancel}>
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
