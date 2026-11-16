/**
 * Native-shell detection: is this page running inside the yaran phone app's machine-view?
 *
 * The app has no JS bridge (D9); the only signal is the `YaranApp/<version> (<os>; <form>)`
 * token machine-view appends to the WebView's User-Agent. The grammar is Phase 02's, so this
 * module wraps its parser rather than carrying a second one.
 *
 * - Pure apart from one memoised read of `navigator.userAgent`.
 * - The token is spoofable: it gates labels and menu entries only, never anything a browser
 *   could abuse (the native entries merely navigate to a scheme a browser cannot handle).
 *
 * <module-headers:begin>
 * Uses:
 * src/lib/native/nativeShell.ts
 * └── @yaran/protocol:src/ua.ts
 * External: none
 *
 * Used by:
 * src/lib/native/nativeShell.ts
 * ├── src/components/OfflineOverlay.tsx
 * ├── src/lib/deviceLabel.ts
 * ├── src/lib/native/nativeShell.test.ts
 * └── src/lib/useAppMenuContext.ts
 * <module-headers:end>
 */
import { parseYaranAppUa, type YaranAppUa } from "@yaran/protocol/ua"

export type NativeShell = YaranAppUa

/** The app token anywhere in a User-Agent, or null in an ordinary browser. */
export function parseNativeShell(ua: string | null | undefined): NativeShell | null {
  return ua ? parseYaranAppUa(ua) : null
}

let memo: { shell: NativeShell | null } | null = null

/** This page's shell, read once: the User-Agent cannot change under a loaded page. */
export function nativeShell(): NativeShell | null {
  if (memo === null) {
    memo = {
      shell: parseNativeShell(
        typeof navigator === "undefined" ? null : navigator.userAgent,
      ),
    }
  }
  return memo.shell
}

/** The one predicate every other module asks. */
export function isNativeShell(): boolean {
  return nativeShell() !== null
}

/** Test seam: forget the memoised read so a test can stub `navigator.userAgent`. */
export function resetNativeShellForTest(): void {
  memo = null
}
