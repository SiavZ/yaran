/**
 * The phone-or-computer width question.
 *
 * One breakpoint decides which shell a surface renders; the hook and the plain function
 * read the same constant, so a component and a non-component caller can never disagree.
 *
 * - `useIsMobile()`: live, render-safe, `false` on the server.
 * - `isMobileViewport()`: the same answer outside React.
 * - `MOBILE_BREAKPOINT`: the width, in CSS pixels.
 *
 * <module-headers:begin>
 * Uses: none
 * External: react
 *
 * Used by:
 * src/use-mobile.ts
 * ├── src/dropdown-menu.tsx
 * ├── src/popover.tsx
 * ├── src/sonner.tsx
 * ├── web:src/App.tsx
 * ├── web:src/components/ChangedFiles.tsx
 * ├── web:src/components/EditorBody.tsx
 * ├── web:src/components/EditorOverlay.tsx
 * ├── web:src/components/FirstLoadDialog.tsx
 * ├── web:src/components/MacroPopover.tsx
 * ├── web:src/components/StandaloneEditor.tsx
 * ├── web:src/components/TaskManagerDialog.tsx
 * ├── web:src/components/TerminalPane.tsx
 * ├── web:src/components/ui/sidebar.tsx
 * ├── web:src/lib/store.ts
 * └── web:src/lib/typingSurface.ts
 * <module-headers:end>
 */
import * as React from "react"

export const MOBILE_BREAKPOINT = 768

/**
 * The same width question, for a caller that is not a component: it reads the
 * width the hook's snapshot reads, from the one breakpoint constant, so the two
 * can never answer differently. Outside a browser there is no shell at all,
 * which reads as the desktop one.
 */
export function isMobileViewport(): boolean {
  if (typeof window === "undefined") return false
  return window.innerWidth < MOBILE_BREAKPOINT
}

function subscribe(callback: () => void) {
  // jsdom ships no matchMedia. A missing one costs only the resize subscription,
  // since the snapshot below reads window.innerWidth directly, so degrade to a
  // no-op unsubscribe instead of crashing tests that never stubbed it.
  if (typeof window.matchMedia !== "function") return () => {}
  const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
  mql.addEventListener("change", callback)
  return () => mql.removeEventListener("change", callback)
}

// `useSyncExternalStore` rather than state mirrored in an effect: the live value
// is read during render (no initial `undefined` flash, no synchronous
// `setState`) and the `false` server snapshot keeps it SSR-safe.
export function useIsMobile() {
  return React.useSyncExternalStore(
    subscribe,
    () => window.innerWidth < MOBILE_BREAKPOINT,
    () => false
  )
}
