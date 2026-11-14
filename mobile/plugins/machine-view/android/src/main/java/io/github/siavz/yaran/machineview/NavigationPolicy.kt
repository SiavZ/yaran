/**
 * Machine-view navigation decisions: the exact-host allowlist and every escape hatch.
 *
 * Main-frame same-host https loads; an Access login redirect becomes the reauth overlay (an
 * IdP is never rendered in the WebView, R5 §2); control URLs act; other web, mail and phone
 * links open in the system browser only on a user gesture; everything else is blocked.
 * Pinned by `fixtures/navigation-cases.json`, which the Swift twin also reads.
 *
 * - Pure. block and ignore decisions carry `diagnostic = true` (one sanitized line each).
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.machineview.NavigationPolicy
 * ├── io.github.siavz.yaran.machineview.ControlUrl (inferred)
 * └── io.github.siavz.yaran.machineview.UrlParts (inferred)
 * External: none
 *
 * Used by:
 * io.github.siavz.yaran.machineview.NavigationPolicy
 * ├── io.github.siavz.yaran.machineview.CallbackUrl (inferred)
 * ├── io.github.siavz.yaran.machineview.MachineState (inferred)
 * ├── io.github.siavz.yaran.machineview.MachineViewActivity (inferred)
 * ├── io.github.siavz.yaran.machineview.MachineViewPlugin (inferred)
 * ├── io.github.siavz.yaran.machineview.MachineWebViewClient (inferred)
 * └── io.github.siavz.yaran.machineview.MachineWindowRobolectricTest (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

enum class NavAction { ALLOW, ALLOW_IN_PLACE, REAUTH, CLOSE_HOME, CLOSE_SETTINGS, EXTERNAL, BLOCK, IGNORE }

data class NavDecision(val action: NavAction, val diagnostic: Boolean)

internal object NavigationPolicy {
    private const val ACCESS_SUFFIX = ".cloudflareaccess.com"
    private const val ACCESS_LOGIN_PATH = "/cdn-cgi/access/login"

    private fun of(action: NavAction) = NavDecision(action, action == NavAction.BLOCK || action == NavAction.IGNORE)

    fun decide(host: String, url: String, mainFrame: Boolean, newWindow: Boolean, gesture: Boolean): NavDecision {
        val loaded = host.lowercase()
        val u = UrlParts.parse(url) ?: return of(NavAction.BLOCK)
        if (!mainFrame) {
            val ok = isAboutBlankOrSrcdoc(u) || (u.scheme == "https" && sameHost(u, loaded))
            return of(if (ok) NavAction.ALLOW else NavAction.BLOCK)
        }
        val external = if (gesture) NavAction.EXTERNAL else NavAction.BLOCK
        val action = when (u.scheme) {
            "about" -> if (isAboutBlankOrSrcdoc(u) && !newWindow) NavAction.ALLOW else NavAction.BLOCK
            "yaranapp" -> when (val c = ControlUrl.decide(url, loaded)) {
                ControlDecision.Reauth -> NavAction.REAUTH
                ControlDecision.Home -> NavAction.CLOSE_HOME
                ControlDecision.Settings -> NavAction.CLOSE_SETTINGS
                is ControlDecision.Ignore -> NavAction.IGNORE
            }
            "https" -> https(u, loaded, newWindow, external)
            "http" -> {
                val hp = u.authority?.let { HostRules.hostPort(it) }
                if (hp == null || hp.first == loaded) NavAction.BLOCK else external
            }
            "mailto", "tel" -> external
            "blob" -> {
                val inner = UrlParts.parse(u.rest)
                if (!newWindow && inner != null && inner.scheme == "https" && sameHost(inner, loaded)) NavAction.ALLOW else NavAction.BLOCK
            }
            else -> NavAction.BLOCK
        }
        return of(action)
    }

    private fun https(u: UrlParts, loaded: String, newWindow: Boolean, external: NavAction): NavAction {
        val (h, port) = u.authority?.let { HostRules.hostPort(it) } ?: return NavAction.BLOCK
        return when {
            h == loaded && HostRules.isDefaultHttpsPort(port) ->
                if (u.path.startsWith(ACCESS_LOGIN_PATH)) NavAction.REAUTH
                else if (newWindow) NavAction.ALLOW_IN_PLACE else NavAction.ALLOW
            h.endsWith(ACCESS_SUFFIX) && h.length > ACCESS_SUFFIX.length -> NavAction.REAUTH
            else -> external
        }
    }

    private fun sameHost(u: UrlParts, loaded: String): Boolean {
        val hp = u.authority?.let { HostRules.hostPort(it) } ?: return false
        return hp.first == loaded && HostRules.isDefaultHttpsPort(hp.second)
    }

    private fun isAboutBlankOrSrcdoc(u: UrlParts) =
        u.scheme == "about" && u.authority == null && (u.rest == "blank" || u.rest == "srcdoc")
}
