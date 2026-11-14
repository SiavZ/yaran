/**
 * Button primitive.
 *
 * The base-ui button with yaran's variants and sizes; every action control on the web
 * and in the phone shell renders through it.
 *
 * - `Button` and `buttonVariants` (cva) for a link styled as a button.
 *
 * <module-headers:begin>
 * Uses:
 * src/button.tsx
 * └── src/cn.ts
 * External: @base-ui/react, class-variance-authority
 *
 * Used by:
 * src/button.tsx
 * ├── @yaran/mobile-shell:src/screens/machines/MachineList.tsx
 * ├── @yaran/mobile-shell:src/screens/machines/RemoveMachineDialog.tsx
 * ├── @yaran/mobile-shell:src/screens/machines/states/Empty.tsx
 * ├── @yaran/mobile-shell:src/screens/machines/states/ErrorState.tsx
 * ├── @yaran/mobile-shell:src/screens/machines/states/Offline.tsx
 * ├── @yaran/mobile-shell:src/screens/machines/states/PhoneRemoved.tsx
 * ├── @yaran/mobile-shell:src/screens/onboarding/ConfirmOrg.tsx
 * ├── @yaran/mobile-shell:src/screens/onboarding/EnterUrl.tsx
 * ├── @yaran/mobile-shell:src/screens/onboarding/ScanQr.tsx
 * ├── @yaran/mobile-shell:src/screens/onboarding/SignInResult.tsx
 * ├── @yaran/mobile-shell:src/screens/onboarding/Welcome.tsx
 * ├── @yaran/mobile-shell:src/screens/orgs/OrgList.tsx
 * ├── @yaran/mobile-shell:src/screens/orgs/SignOutOrgDialog.tsx
 * ├── @yaran/mobile-shell:src/screens/settings/Diagnostics.tsx
 * ├── @yaran/mobile-shell:src/screens/settings/EraseDialog.tsx
 * ├── @yaran/mobile-shell:src/screens/settings/LockScreen.tsx
 * ├── @yaran/mobile-shell:src/screens/settings/Settings.tsx
 * ├── src/dialog.tsx
 * ├── src/sheet.tsx
 * ├── web:src/components/AccessoryBar.tsx
 * ├── web:src/components/AddProjectDialog.tsx
 * ├── web:src/components/AgentEnvDialog.tsx
 * ├── web:src/components/AgentNotFound.tsx
 * ├── web:src/components/AgentStartupCommandDialog.tsx
 * ├── web:src/components/AppMenu.tsx
 * ├── web:src/components/AppMenuSheet.tsx
 * ├── web:src/components/AttachPullRequestDialog.tsx
 * ├── web:src/components/ChangeProviderDialog.tsx
 * ├── web:src/components/ChangedFiles.tsx
 * ├── web:src/components/CheckoutDefaultBranchDialog.tsx
 * ├── web:src/components/ChunkBoundary.tsx
 * ├── web:src/components/CommitDialog.tsx
 * ├── web:src/components/ComposeBar.tsx
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
 * ├── web:src/components/CreateAgentDialog.tsx
 * ├── web:src/components/CreationOverflowMenuItems.test.tsx
 * ├── web:src/components/CustomizeWebappDialog.tsx
 * ├── web:src/components/DeleteEntryDialog.tsx
 * ├── web:src/components/DeleteProjectDialog.tsx
 * ├── web:src/components/DeleteSessionDialog.tsx
 * ├── web:src/components/DormantTabCard.tsx
 * ├── web:src/components/DormantTabSurface.tsx
 * ├── web:src/components/EditorBody.tsx
 * ├── web:src/components/FileDiskBanner.tsx
 * ├── web:src/components/FileInfoDialog.tsx
 * ├── web:src/components/FirstLoadDialog.tsx
 * ├── web:src/components/FlatAgentList.tsx
 * ├── web:src/components/GlobalEnvDialog.tsx
 * ├── web:src/components/InputMenu.tsx
 * ├── web:src/components/InsetHeader.tsx
 * ├── web:src/components/LauncherCorner.tsx
 * ├── web:src/components/MacroPopover.tsx
 * ├── web:src/components/MacrosDialog.tsx
 * ├── web:src/components/MobileShell.tsx
 * ├── web:src/components/MoveEntryDialog.tsx
 * ├── web:src/components/NewAgentPickerDialog.tsx
 * ├── web:src/components/NewEntryDialog.tsx
 * ├── web:src/components/OfflineOverlay.tsx
 * ├── web:src/components/PaneActionCluster.tsx
 * ├── web:src/components/PaneMenu.tsx
 * ├── web:src/components/ProjectSettingsDialog.tsx
 * ├── web:src/components/RemoveProjectDialog.tsx
 * ├── web:src/components/RenameEntryDialog.tsx
 * ├── web:src/components/RenameSessionDialog.tsx
 * ├── web:src/components/SaveConflictDialog.tsx
 * ├── web:src/components/Sidebar.tsx
 * ├── web:src/components/StandaloneAgentDialog.tsx
 * ├── web:src/components/StartupLogsDialog.tsx
 * ├── web:src/components/TaskManagerDialog.tsx
 * ├── web:src/components/TerminalArea.tsx
 * ├── web:src/components/TerminalPane.tsx
 * ├── web:src/components/TheaterPill.tsx
 * ├── web:src/components/TheaterToggle.tsx
 * ├── web:src/components/WorktreesDialog.tsx
 * ├── web:src/components/cloud/CloudDialog.tsx
 * ├── web:src/components/cloud/CloudLogoutDialog.tsx
 * ├── web:src/components/cloud/CloudRotateDialog.tsx
 * ├── web:src/components/ui/input-group.tsx
 * ├── web:src/components/ui/sidebar.tsx
 * └── web:src/lib/uiKitSingleReact.test.tsx
 * <module-headers:end>
 */
import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "./cn"

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/80",
        outline:
          "border-border bg-background hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground data-[popup-open]:bg-muted data-[popup-open]:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground data-[popup-open]:bg-secondary data-[popup-open]:text-secondary-foreground",
        ghost:
          "hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground data-[popup-open]:bg-muted data-[popup-open]:text-foreground dark:hover:bg-muted/50",
        destructive:
          "bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30 dark:focus-visible:ring-destructive/40",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default:
          "h-8 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        xs: "h-6 gap-1 rounded-[min(var(--radius-md),10px)] px-2 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        icon: "size-8",
        "icon-xs":
          "size-6 rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
        "icon-sm":
          "size-7 rounded-[min(var(--radius-md),12px)] in-data-[slot=button-group]:rounded-lg",
        "icon-lg": "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
