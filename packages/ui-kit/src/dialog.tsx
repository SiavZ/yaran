/**
 * Dialog primitive.
 *
 * The base-ui dialog with yaran's modal chrome: overlay, popup, header, footer, title
 * and description, plus the destructive backdrop variant.
 *
 * - `Dialog` and its parts; Escape during IME composition never closes it.
 *
 * <module-headers:begin>
 * Uses:
 * src/dialog.tsx
 * ├── src/button.tsx
 * └── src/cn.ts
 * External: @base-ui/react, lucide-react, react
 *
 * Used by:
 * src/dialog.tsx
 * ├── @yaran/mobile-shell:src/screens/machines/RemoveMachineDialog.tsx
 * ├── @yaran/mobile-shell:src/screens/orgs/SignOutOrgDialog.tsx
 * ├── @yaran/mobile-shell:src/screens/settings/EraseDialog.tsx
 * ├── src/dialog.test.tsx
 * ├── web:src/components/AddProjectDialog.tsx
 * ├── web:src/components/AgentEnvDialog.tsx
 * ├── web:src/components/AgentInfoDialog.tsx
 * ├── web:src/components/AgentStartupCommandDialog.tsx
 * ├── web:src/components/AttachPullRequestDialog.tsx
 * ├── web:src/components/ChangeProviderDialog.tsx
 * ├── web:src/components/CheckoutDefaultBranchDialog.tsx
 * ├── web:src/components/CommitDialog.tsx
 * ├── web:src/components/ConfigEditorDialog.tsx
 * ├── web:src/components/ConfirmCloseEditorTabDialog.tsx
 * ├── web:src/components/ConfirmCloseTabDialog.tsx
 * ├── web:src/components/ConfirmDeleteTerminalDialog.tsx
 * ├── web:src/components/ConfirmDetachAgentDialog.tsx
 * ├── web:src/components/ConfirmDiscardFileDialog.tsx
 * ├── web:src/components/ConfirmDiscardFilesDialog.tsx
 * ├── web:src/components/ConfirmForceReconnectDialog.tsx
 * ├── web:src/components/ConfirmForceStopAgentDialog.tsx
 * ├── web:src/components/ConfirmRecreateWorkingCopyDialog.tsx
 * ├── web:src/components/ConfirmReloadFileDialog.tsx
 * ├── web:src/components/ConfirmUseExistingBranchDialog.tsx
 * ├── web:src/components/ConfirmVanishedEditorDialog.tsx
 * ├── web:src/components/ConnectPhoneDialog.tsx
 * ├── web:src/components/CreateAgentDialog.tsx
 * ├── web:src/components/CustomizeWebappDialog.tsx
 * ├── web:src/components/DeleteEntryDialog.tsx
 * ├── web:src/components/DeleteProjectDialog.tsx
 * ├── web:src/components/DeleteSessionDialog.tsx
 * ├── web:src/components/EditorOverlay.tsx
 * ├── web:src/components/FileInfoDialog.tsx
 * ├── web:src/components/FirstLoadDialog.tsx
 * ├── web:src/components/GlobalEnvDialog.tsx
 * ├── web:src/components/MacrosDialog.tsx
 * ├── web:src/components/MoveEntryDialog.tsx
 * ├── web:src/components/NewAgentPickerDialog.tsx
 * ├── web:src/components/NewEntryDialog.tsx
 * ├── web:src/components/ProjectInfoDialog.tsx
 * ├── web:src/components/ProjectSettingsDialog.tsx
 * ├── web:src/components/RemoveProjectDialog.tsx
 * ├── web:src/components/RenameEntryDialog.tsx
 * ├── web:src/components/RenameSessionDialog.tsx
 * ├── web:src/components/SaveConflictDialog.tsx
 * ├── web:src/components/StandaloneAgentDialog.tsx
 * ├── web:src/components/StartupLogsDialog.tsx
 * ├── web:src/components/TaskManagerDialog.tsx
 * ├── web:src/components/WorktreesDialog.tsx
 * ├── web:src/components/cloud/CloudDialog.tsx
 * ├── web:src/components/cloud/CloudLogoutDialog.tsx
 * ├── web:src/components/cloud/CloudRotateDialog.tsx
 * ├── web:src/components/ui/command.tsx
 * └── web:src/lib/uiKitSingleReact.test.tsx
 * <module-headers:end>
 */
import * as React from "react"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"

import { cn } from "./cn"
import { Button } from "./button"
import { XIcon } from "lucide-react"

function Dialog({ onOpenChange, ...props }: DialogPrimitive.Root.Props) {
  return (
    <DialogPrimitive.Root
      data-slot="dialog"
      {...props}
      onOpenChange={(open, details) => {
        // Escape cancels an IME candidate before it dismisses the form.
        const event = details.event
        if (
          !open &&
          details.reason === "escape-key" &&
          event instanceof KeyboardEvent &&
          (event.isComposing || event.keyCode === 229)
        ) {
          details.cancel()
          return
        }
        onOpenChange?.(open, details)
      }}
    />
  )
}

function DialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({ ...props }: DialogPrimitive.Portal.Props) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  ...props
}: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 isolate z-50 bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-sm data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
        className
      )}
      {...props}
    />
  )
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  destructive = false,
  ...props
}: DialogPrimitive.Popup.Props & {
  showCloseButton?: boolean
  // When true, the shared backdrop also desaturates the app behind it
  // (black-and-white) as an extra danger cue for consequential confirm dialogs.
  // Blur stays on the base overlay for every dialog regardless.
  destructive?: boolean
}) {
  return (
    <DialogPortal>
      <DialogOverlay
        className={destructive ? "backdrop-grayscale" : undefined}
      />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        // max-h caps the popup to the dynamic viewport (dvh tracks the soft
        // keyboard on mobile) with internal scroll, so a focused input and the
        // footer buttons stay reachable when the keyboard opens. The popup
        // portals to document.body (outside the keyboard-pinned mobile root), so
        // this cap is what keeps tall dialogs usable on phones.
        //
        // grid-cols-[minmax(0,1fr)]: without it the grid's implicit column is
        // min-content sized, so one child with a long unbreakable string (a
        // branch name, a path) widens the column past max-w, every sibling
        // stretches with it, and the popup grows a horizontal scrollbar. Capping
        // the column at the popup's width is what makes children's
        // min-w-0/truncate chains engage.
        className={cn(
          "fixed top-1/2 left-1/2 z-50 grid max-h-[calc(100dvh-2rem)] w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 grid-cols-[minmax(0,1fr)] gap-4 overflow-y-auto rounded-xl bg-popover p-4 text-sm text-popover-foreground ring-1 ring-foreground/10 duration-100 outline-none sm:max-w-sm data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          showCloseButton && "[&_[data-slot=dialog-header]]:pr-10",
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            render={
              <Button
                variant="ghost"
                className="absolute top-2 right-2 max-md:size-10"
                size="icon-sm"
              />
            }
          >
            <XIcon
            />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2", className)}
      {...props}
    />
  )
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean
}) {
  return (
    <div
      data-slot="dialog-footer"
      // max-md:[&_button]:min-h-11 gives every footer action a ≥44px touch
      // target on phones (desktop keeps the compact h-8 default via md:).
      className={cn(
        "-mx-4 -mb-4 flex flex-col-reverse gap-2 rounded-b-xl border-t bg-muted/50 p-4 max-md:[&_button]:min-h-11 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close render={<Button variant="outline" />}>
          Close
        </DialogPrimitive.Close>
      )}
    </div>
  )
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn(
        "font-heading text-base leading-none font-medium",
        className
      )}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        "text-sm text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
        className
      )}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
