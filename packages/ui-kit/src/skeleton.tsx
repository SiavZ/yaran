/**
 * Skeleton placeholder.
 *
 * A pulsing muted block standing in for content that is still loading.
 *
 * - `Skeleton`.
 *
 * <module-headers:begin>
 * Uses:
 * src/skeleton.tsx
 * └── src/cn.ts
 * External: none
 *
 * Used by:
 * src/skeleton.tsx
 * └── web:src/components/ui/sidebar.tsx
 * <module-headers:end>
 */
import { cn } from "./cn"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-md bg-muted", className)}
      {...props}
    />
  )
}

export { Skeleton }
