/**
 * Single-line input primitive.
 *
 * The base-ui input with token styling, focus ring and invalid state.
 *
 * - `Input`.
 *
 * <module-headers:begin>
 * Uses:
 * src/input.tsx
 * └── src/cn.ts
 * External: @base-ui/react, react
 *
 * Used by:
 * src/input.tsx
 * ├── @yaran/mobile-shell:src/screens/onboarding/EnterUrl.tsx
 * ├── web:src/components/AddProjectDialog.tsx
 * ├── web:src/components/AttachPullRequestDialog.tsx
 * ├── web:src/components/ChangedFiles.tsx
 * ├── web:src/components/CreateAgentDialog.tsx
 * ├── web:src/components/CustomizeWebappDialog.tsx
 * ├── web:src/components/EditorBody.tsx
 * ├── web:src/components/MacrosDialog.tsx
 * ├── web:src/components/NewEntryDialog.tsx
 * ├── web:src/components/RenameEntryDialog.tsx
 * ├── web:src/components/RenameSessionDialog.tsx
 * ├── web:src/components/StandaloneAgentDialog.tsx
 * ├── web:src/components/WorktreesDialog.tsx
 * ├── web:src/components/cloud/CloudDialog.tsx
 * ├── web:src/components/ui/input-group.tsx
 * └── web:src/components/ui/sidebar.tsx
 * <module-headers:end>
 */
import * as React from "react"
import { Input as InputPrimitive } from "@base-ui/react/input"

import { cn } from "./cn"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 max-md:min-h-10 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    />
  )
}

export { Input }
