// The app menu's context, built once for every renderer (the desktop flyout's
// `AppMenuBody`, which is also every Settings drill, and the phone sheet).
import { useYaran } from "@/lib/store"
import type { AppMenuContext } from "@/lib/appMenu"
import { isNativeShell } from "@/lib/native/nativeShell"

export function useAppMenuContext(): AppMenuContext {
  const { bootstrap } = useYaran()
  const nativeShell = isNativeShell()
  return {
    ghAvailable: bootstrap?.gh_available ?? false,
    githubIntegrationEnabled: bootstrap?.github_integration ?? false,
    nativeShell,
    // A phone already inside the app needs no QR code to get there.
    phonePairing: (bootstrap?.cloud?.paired ?? false) && !nativeShell,
  }
}
