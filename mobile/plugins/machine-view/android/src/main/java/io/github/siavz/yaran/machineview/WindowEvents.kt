/**
 * What the machine window does with a navigation, a main-frame refusal and an overlay button:
 * the decisions `NavigationPolicy` and `RefusalPolicy` made, acted on.
 *
 * The page's own Sign in navigates to the strict `yaranapp://reauth` control URL: an org route
 * renews through its handoff, a direct route asks its native password sheet (validated against
 * the instance again before anything loads). A real Cloudflare Access redirect on a direct
 * machine is not a sign-in: it says the machine belongs to an org. Under the lock cover no
 * button behind it acts.
 *
 * - Main thread; extensions of [MachineViewActivity], split out to keep the window readable.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.machineview.WindowEvents
 * ├── io.github.siavz.yaran.machineview.ExternalLinks (inferred)
 * ├── io.github.siavz.yaran.machineview.MachineViewActivity (inferred)
 * ├── io.github.siavz.yaran.machineview.NavigationPolicy (inferred)
 * ├── io.github.siavz.yaran.machineview.RefusalPolicy (inferred)
 * └── io.github.siavz.yaran.machineview.UrlParts (inferred)
 * External: none
 *
 * Used by:
 * io.github.siavz.yaran.machineview.WindowEvents
 * ├── io.github.siavz.yaran.machineview.AdmissionRobolectricTest (inferred)
 * ├── io.github.siavz.yaran.machineview.MachineViewActivity (inferred)
 * └── io.github.siavz.yaran.machineview.ShareBatchRobolectricTest (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

internal fun MachineViewActivity.navigate(decision: NavDecision, url: String) {
    when (decision.action) {
        // The page's own Sign in (the strict control URL) asks a direct machine's native sheet; a real
        // Access redirect on a direct machine means it belongs to an org.
        NavAction.REAUTH -> when {
            orgRoute -> onReauthSignal()
            url.startsWith("yaranapp:") -> routes.directSignIn()
            else -> showOverlay("access_on_direct")
        }
        NavAction.CLOSE_HOME -> close("home", null)
        NavAction.CLOSE_SETTINGS -> close("settings", null)
        NavAction.EXTERNAL -> ExternalLinks.open(this, url, rt.core.diagnostics)
        NavAction.BLOCK, NavAction.IGNORE, NavAction.ALLOW, NavAction.ALLOW_IN_PLACE -> Unit
    }
    if (decision.diagnostic) {
        val scheme = UrlParts.parse(url)?.scheme ?: "unparseable"
        rt.core.diagnostics.append("machine-view navigation ${decision.action.name.lowercase()} scheme=$scheme")
    }
}

internal fun MachineViewActivity.refused(decision: RefusalDecision, code: String?) {
    val safe = code?.takeIf { Regex("^[a-z0-9-]{1,64}$").matches(it) } ?: "invalid"
    if (decision.diagnostic) rt.core.diagnostics.append("machine-view unknown refusal code=$safe host=$host")
    when (decision.overlay) {
        RefusalOverlay.REAUTH -> onReauthSignal()
        RefusalOverlay.OFFLINE -> onLoadFailed()
        RefusalOverlay.NONE -> Unit
        else -> showOverlay(RefusalPolicy.overlayKey(decision.overlay), safe)
    }
}

internal fun MachineViewActivity.overlayAction(action: String) {
    if (rt.core.appLock.isLocked()) return // under the lock cover nothing behind it may act
    when (action) {
        "sign_in", "renew" -> if (orgRoute) coordinator.renewNow { } else routes.directSignIn()
        "back_to_machines" -> close("user", null)
        "retry" -> {
            overlay.hide()
            if (orgOnly) load(state.url) else routes.select(if (web?.url == null) null else state.chosen, retry = true)
        }
        "try_another_route" -> {
            overlay.hide()
            routes.select(state.chosen, retry = true)
        }
        "discard" -> share.discard()
    }
}
