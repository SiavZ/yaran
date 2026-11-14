/**
 * Class-name joiner for every kit primitive.
 *
 * Merges conditional class lists and lets a later Tailwind utility win over a
 * conflicting earlier one, so a caller's `className` overrides a primitive's default.
 *
 * - `cn(...)`: clsx for the conditions, tailwind-merge for the conflicts.
 *
 * <module-headers:begin>
 * Uses: none
 * External: clsx, tailwind-merge
 *
 * Used by:
 * src/cn.ts
 * ├── src/button.tsx
 * ├── src/card.tsx
 * ├── src/checkbox.tsx
 * ├── src/dialog.tsx
 * ├── src/dropdown-menu.tsx
 * ├── src/empty.tsx
 * ├── src/inline-code.tsx
 * ├── src/input.tsx
 * ├── src/popover.tsx
 * ├── src/scroll-area.tsx
 * ├── src/select.tsx
 * ├── src/separator.tsx
 * ├── src/sheet.tsx
 * ├── src/skeleton.tsx
 * ├── src/switch.tsx
 * ├── src/tooltip.tsx
 * ├── web:src/components/AccessoryBar.tsx
 * ├── web:src/components/AgentTabsStrip.tsx
 * ├── web:src/components/AgentVitalsTooltip.tsx
 * ├── web:src/components/ChangedFiles.tsx
 * ├── web:src/components/ConnDot.tsx
 * ├── web:src/components/CustomizeWebappDialog.tsx
 * ├── web:src/components/EditorBody.tsx
 * ├── web:src/components/EditorIcon.tsx
 * ├── web:src/components/EditorTabsStrip.tsx
 * ├── web:src/components/FileStatusIcon.tsx
 * ├── web:src/components/FileTree.tsx
 * ├── web:src/components/FileTreeIcon.tsx
 * ├── web:src/components/FlatAgentList.tsx
 * ├── web:src/components/GlyphSpinner.tsx
 * ├── web:src/components/InputMenu.tsx
 * ├── web:src/components/LauncherCorner.tsx
 * ├── web:src/components/MacrosDialog.tsx
 * ├── web:src/components/MobileActionFlap.tsx
 * ├── web:src/components/MobileShell.tsx
 * ├── web:src/components/NewAgentPickerDialog.tsx
 * ├── web:src/components/PaneActionCluster.tsx
 * ├── web:src/components/PrBanner.tsx
 * ├── web:src/components/Sidebar.tsx
 * ├── web:src/components/StatusBadge.tsx
 * ├── web:src/components/TaskManagerDialog.tsx
 * ├── web:src/components/TheaterChrome.tsx
 * ├── web:src/components/TheaterPill.tsx
 * ├── web:src/components/theaterPillBox.ts
 * ├── web:src/components/ui/avatar.tsx
 * ├── web:src/components/ui/badge.tsx
 * ├── web:src/components/ui/breadcrumb.tsx
 * ├── web:src/components/ui/button-group.tsx
 * ├── web:src/components/ui/command.tsx
 * ├── web:src/components/ui/context-menu.tsx
 * ├── web:src/components/ui/input-group.tsx
 * ├── web:src/components/ui/resizable.tsx
 * ├── web:src/components/ui/sidebar.tsx
 * ├── web:src/components/ui/tabs.tsx
 * └── web:src/components/ui/textarea.tsx
 * <module-headers:end>
 */
import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
