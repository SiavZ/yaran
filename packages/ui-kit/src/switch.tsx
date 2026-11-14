/**
 * Switch primitive.
 *
 * The base-ui switch with a token-styled track and thumb in two sizes.
 *
 * - `Switch`.
 *
 * <module-headers:begin>
 * Uses:
 * src/switch.tsx
 * └── src/cn.ts
 * External: @base-ui/react
 *
 * Used by:
 * src/switch.tsx
 * ├── @yaran/mobile-shell:src/screens/settings/SettingRow.tsx
 * └── web:src/components/CustomizeWebappDialog.tsx
 * <module-headers:end>
 */
import { Switch as SwitchPrimitive } from "@base-ui/react/switch"

import { cn } from "./cn"

// A settings toggle is visually a switch, not a checkbox, and base-ui ships
// one, so per the "shadcn/base-ui first" tenet we wrap it rather than reusing
// Checkbox. Sized so the whole control (including invisible padding) clears
// the 40px touch-target floor on phones; desktop density is unchanged.
function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent shadow-xs transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[checked]:bg-primary data-[unchecked]:bg-input max-md:after:absolute max-md:after:-inset-2.5",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block size-4 rounded-full bg-background shadow-lg ring-0 transition-transform data-[checked]:translate-x-4 data-[unchecked]:translate-x-0.5"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
