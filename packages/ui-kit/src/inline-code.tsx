/**
 * The name chip.
 *
 * Every variable a dialog or toast shows (a branch, a path, a command) renders as this
 * inline code chip instead of being quoted.
 *
 * - `InlineCode`: token-styled, wraps anywhere, keeps inner whitespace.
 *
 * <module-headers:begin>
 * Uses:
 * src/inline-code.tsx
 * └── src/cn.ts
 * External: none
 *
 * Used by:
 * src/inline-code.tsx
 * ├── @yaran/mobile-shell:src/screens/machines/RemoveMachineDialog.tsx
 * ├── @yaran/mobile-shell:src/screens/machines/states/Empty.tsx
 * ├── @yaran/mobile-shell:src/screens/machines/states/PhoneRemoved.tsx
 * ├── @yaran/mobile-shell:src/screens/onboarding/ConfirmOrg.tsx
 * ├── @yaran/mobile-shell:src/screens/onboarding/SignInResult.tsx
 * ├── @yaran/mobile-shell:src/screens/onboarding/Welcome.tsx
 * ├── @yaran/mobile-shell:src/screens/orgs/SignOutOrgDialog.tsx
 * ├── src/inline-code.test.tsx
 * ├── web:src/components/AddProjectDialog.tsx
 * ├── web:src/components/AgentEnvDialog.tsx
 * ├── web:src/components/AgentInfoDialog.tsx
 * ├── web:src/components/AgentNotFound.tsx
 * ├── web:src/components/AgentStartupCommandDialog.tsx
 * ├── web:src/components/AttachPullRequestDialog.tsx
 * ├── web:src/components/ChangeProviderDialog.tsx
 * ├── web:src/components/ConfigEditorDialog.tsx
 * ├── web:src/components/ConfirmCloseEditorTabDialog.tsx
 * ├── web:src/components/ConfirmCloseTabDialog.tsx
 * ├── web:src/components/ConfirmDeleteTerminalDialog.tsx
 * ├── web:src/components/ConfirmDiscardFileDialog.tsx
 * ├── web:src/components/ConfirmForceReconnectDialog.tsx
 * ├── web:src/components/ConfirmReloadFileDialog.tsx
 * ├── web:src/components/ConfirmUseExistingBranchDialog.tsx
 * ├── web:src/components/DeleteEntryDialog.tsx
 * ├── web:src/components/DeleteSessionDialog.tsx
 * ├── web:src/components/FileInfoDialog.tsx
 * ├── web:src/components/MoveEntryDialog.tsx
 * ├── web:src/components/NewAgentPickerDialog.tsx
 * ├── web:src/components/NewEntryDialog.tsx
 * ├── web:src/components/ProjectInfoDialog.tsx
 * ├── web:src/components/ProjectSettingsDialog.tsx
 * ├── web:src/components/RenameEntryDialog.tsx
 * ├── web:src/components/SaveConflictDialog.tsx
 * ├── web:src/components/StandaloneAgentDialog.tsx
 * ├── web:src/components/WorktreesDialog.tsx
 * ├── web:src/lib/inlineMarkdown.test.tsx
 * ├── web:src/lib/inlineMarkdown.tsx
 * └── web:src/lib/prose.tsx
 * <module-headers:end>
 */
import { cn } from "./cn"

// The one chip for a name inside prose: a branch, a path, a file, a command, an
// agent, project or terminal name, a pull request number. The chip is what
// tells the name apart from the sentence around it, so callers drop the quotes
// they used to wrap it in. Sized relative to its surroundings, so it sits in a
// dialog title as comfortably as in body text. It wraps anywhere, because a path
// has no spaces to break at and a phone must never scroll sideways, and it keeps
// runs of spaces, because in a command they are part of the value. To a screen
// reader it is plain inline text.
function InlineCode({ className, ...props }: React.ComponentProps<"code">) {
  return (
    <code
      data-slot="inline-code"
      className={cn(
        "rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em] box-decoration-clone whitespace-pre-wrap wrap-anywhere",
        className,
      )}
      {...props}
    />
  )
}

export { InlineCode }
