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
 * ├── @yaran/ui-kit:src/button.tsx
 * ├── @yaran/ui-kit:src/dialog.tsx
 * └── @yaran/ui-kit:src/inline-code.tsx
 * External: react
 *
 * Used by:
 * src/components/cloud/CloudLogoutDialog.tsx
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
  const cancel = useRef<HTMLButtonElement>(null)
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      {/* Cancel is focused through Base UI's focus queue, not autoFocus: an
          autoFocused element makes the confirm queue nothing, so the parent Cloud
          dialog's still-pending first-focus frame would move focus off Cancel. */}
      <DialogContent showCloseButton={false} destructive initialFocus={cancel}>
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
          <Button ref={cancel} variant="outline" onClick={onCancel}>
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
