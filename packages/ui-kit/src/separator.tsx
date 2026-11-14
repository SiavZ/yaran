/**
 * Separator primitive.
 *
 * A horizontal or vertical rule in the border token.
 *
 * - `Separator`.
 *
 * <module-headers:begin>
 * Uses:
 * src/separator.tsx
 * └── src/cn.ts
 * External: @base-ui/react
 *
 * Used by:
 * src/separator.tsx
 * ├── @yaran/mobile-shell:src/screens/settings/Settings.tsx
 * ├── web:src/components/ChangedFiles.tsx
 * ├── web:src/components/ui/button-group.tsx
 * └── web:src/components/ui/sidebar.tsx
 * <module-headers:end>
 */
import { Separator as SeparatorPrimitive } from "@base-ui/react/separator"

import { cn } from "./cn"

function Separator({
  className,
  orientation = "horizontal",
  ...props
}: SeparatorPrimitive.Props) {
  return (
    <SeparatorPrimitive
      data-slot="separator"
      orientation={orientation}
      className={cn(
        "shrink-0 bg-border data-horizontal:h-px data-horizontal:w-full data-vertical:w-px data-vertical:self-stretch",
        className
      )}
      {...props}
    />
  )
}

export { Separator }
