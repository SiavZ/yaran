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
 * ├── web:src/components/AttachPullRequestDialog.tsx
 * ├── web:src/components/ChangedFiles.tsx
 * ├── web:src/components/CustomizeWebappDialog.tsx
 * ├── web:src/components/EditorBody.tsx
 * ├── web:src/components/EditorOverlay.tsx
 * ├── web:src/components/FirstLoadDialog.tsx
 * ├── web:src/components/MacroPopover.tsx
 * ├── web:src/components/NewLauncherDialog.tsx
 * ├── web:src/components/PaneActionCluster.tsx
 * ├── web:src/components/PaneInputGroup.tsx
 * ├── web:src/components/PullRequestsDialog.tsx
 * ├── web:src/components/StandaloneEditor.tsx
 * ├── web:src/components/TaskManagerDialog.tsx
 * ├── web:src/components/terminal/partSetup.tsx
 * ├── web:src/components/ui/sidebar.tsx
 * └── web:src/lib/store.ts
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
  // The media query, not `innerWidth`: the CSS breakpoints answer from the layout
  // viewport, while a phone's `innerWidth` follows pinch zoom and horizontal
  // overflow and can read past the breakpoint, which painted the desktop shell
  // on a phone. Only a browser without matchMedia (jsdom) reads the width.
  if (typeof window.matchMedia !== "function") {
    return window.innerWidth < MOBILE_BREAKPOINT
  }
  return window.matchMedia(MOBILE_QUERY).matches
}

const MOBILE_QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`

function subscribe(callback: () => void) {
  // jsdom ships no matchMedia, and the snapshot then reads the width directly,
  // so degrade to a no-op unsubscribe instead of crashing tests that never
  // stubbed it.
  if (typeof window.matchMedia !== "function") return () => {}
  const mql = window.matchMedia(MOBILE_QUERY)
  mql.addEventListener("change", callback)
  return () => mql.removeEventListener("change", callback)
}

// `useSyncExternalStore` rather than state mirrored in an effect: the live value
// is read during render (no initial `undefined` flash, no synchronous
// `setState`) and the `false` server snapshot keeps it SSR-safe.
export function useIsMobile() {
  return React.useSyncExternalStore(
    subscribe,
    isMobileViewport,
    () => false
  )
}
