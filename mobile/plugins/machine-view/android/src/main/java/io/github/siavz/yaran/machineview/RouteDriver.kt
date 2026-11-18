/**
 * The machine window's direct and routed half (G1, G2): route selection and what follows it.
 *
 * At open the user's routes are probed in order on the io executor; at resume after the page
 * was away and from the offline overlay the current route is probed first and kept when it
 * answers, so a healthy page is never moved. A chosen route that differs from the current one
 * gets a fresh WebView before anything loads, and only its own credential is injected (an org
 * route's `CF_Authorization` through the Phase 15 path, a direct route's `yaran_session_<port>`
 * after the native password sheet when the machine asks for one). A lone direct route whose
 * machine answers with another instance closes `instance_changed`; a routed window that no
 * route answers at open closes `no_route`; anything else is an overlay.
 *
 * - Main thread, apart from the probes.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.machineview.RouteDriver
 * ├── io.github.siavz.yaran.machineview.Direct (inferred)
 * ├── io.github.siavz.yaran.machineview.DirectFlow (inferred)
 * ├── io.github.siavz.yaran.machineview.MachineState (inferred)
 * ├── io.github.siavz.yaran.machineview.MachineViewActivity (inferred)
 * ├── io.github.siavz.yaran.machineview.Messages (inferred)
 * └── io.github.siavz.yaran.machineview.RouteSelector (inferred)
 * External: android.content, android.net, android.os, java.util.concurrent.atomic
 *
 * Used by:
 * io.github.siavz.yaran.machineview.RouteDriver
 * └── io.github.siavz.yaran.machineview.MachineViewActivity (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import java.util.concurrent.atomic.AtomicReference

internal class RouteDriver(private val w: MachineViewActivity) {
    private val main = Handler(Looper.getMainLooper())
    private val orgRoute get() = w.state.route is Route.Org

    /**
     * The instance the chosen direct route answered with at its last probe. A stored direct
     * session is used only when it was issued by exactly this instance (read on the io thread).
     */
    @Volatile private var observed: String? = null

    /** The sign-in this window itself just made: usable before a probe can bind it (a machine with no instance id). */
    @Volatile private var fresh: String? = null

    /**
     * A new open while the window is up: the old target is reported closed (with its own host),
     * its page, credentials and undelivered shared files go, and the new target starts as a
     * fresh open would, taking the files and read grant its intent carries.
     */
    fun replace(next: MachineState, intent: Intent) {
        w.emitClosed("user", null)
        w.closedEmitted = false
        w.intent = intent
        w.state = next
        w.startRequested = false
        w.started = false
        w.reloadAtUnlock = false
        w.pausedAt = null
        observed = null
        fresh = null
        w.openGen += 1 // every continuation of the old target is stale from here
        w.dismissDialogs()
        w.freshWebView()
        w.share.discard()
        w.share.take(intent, restored = false)
        if (!w.rt.core.appLock.isLocked()) w.start()
    }

    /** Probes the routes off the main thread ([current] null at open) and acts on the choice. */
    fun select(current: Int?, retry: Boolean) {
        val s = w.state
        val rt = w.rt
        rt.io.execute {
            val statuses = arrayOfNulls<DirectStatus>(s.routes.size)
            val sel = try {
                RouteSelector.select(s.routes.size, current) { i -> DirectFlow.probeRoute(rt, s.routes[i], s.instance).also { statuses[i] = it.second }.first }
            } catch (e: Exception) {
                rt.core.diagnostics.append("machine-view route probe failed error=${e.javaClass.simpleName}")
                Selection.NoRoute
            }
            main.post { if (!w.isFinishing && w.state === s) onSelected(sel, statuses, current, retry) }
        }
    }

    /** [retry]: the page must (re)load once (a retry, a renewal, or a renderer lost under the lock). */
    internal fun onSelected(sel: Selection, statuses: Array<DirectStatus?>, current: Int?, retry: Boolean) {
        w.started = true
        when (sel) {
            is Selection.Kept -> {
                // Admitted only for a load that follows; a page kept as it is holds no admission.
                if (retry) admitFrom(statuses[sel.index]) else w.admitted = null
                (statuses[sel.index] as? DirectStatus.Yaran)?.let { observed = it.instance }
                when {
                    retry -> loadRoute(statuses[sel.index])
                    // The session read (and its stale-instance cleanup) decides any sheet, as on every path.
                    !orgRoute -> settleDirect(statuses[sel.index]) { injectDirect() }
                    else -> reinject()
                }
            }
            is Selection.Chosen -> {
                switchTo(sel.index)
                admitFrom(statuses[sel.index])
                (statuses[sel.index] as? DirectStatus.Yaran)?.let { observed = it.instance }
                loadRoute(statuses[sel.index])
            }
            is Selection.SignInFirst -> {
                switchTo(sel.index)
                loadRoute(null)
            }
            Selection.NoRoute -> when {
                // A yaran too old for the app is never shown, at open or under a page it replaced.
                current != null && statuses[current] is DirectStatus.UpgradeRequired -> w.close("error", "upgrade_required")
                // A lone direct machine that answered as a yaran yet did not match is another machine, not offline.
                current != null && w.state.kind == OpenKind.DIRECT && statuses[current] is DirectStatus.Yaran -> w.close("error", "instance_changed")
                w.state.kind == OpenKind.ROUTES && current == null ->
                    w.close("error", if (statuses.any { it is DirectStatus.UpgradeRequired }) "upgrade_required" else "no_route")
                w.state.kind == OpenKind.ROUTES && retry -> {
                    w.showOverlay("offline_routes")
                    w.toast(Messages.fill(Messages.overlay.getValue("no_other_route").message, w.vars()))
                }
                current != null && !retry -> w.rt.core.diagnostics.append("machine-view no route answered at resume; the page stays")
                else -> directFailure(statuses[0])
            }
        }
    }

    private fun admitFrom(s: DirectStatus?) {
        w.admitted = if (s is DirectStatus.Yaran) w.openGen else null
    }

    /** The one document load this window just admitted natively: its generation and URL without the fragment. */
    private val pass = AtomicReference<Pair<Int, String>?>(null)

    /** [MachineViewActivity.load] is about to load [url]: its document request needs no second probe. */
    fun pass(url: String) = pass.set(w.openGen to url.substringBefore('#'))

    private enum class Verdict { ADMIT, RESELECT, SIGN_IN, REFUSE }

    /**
     * What a fresh probe of [route] means for loading a document of it here (io or WebView request
     * thread). The page's yaran must say its page signs in natively (`native_auth_ui`;
     * compatibility, never authorization), and must still be the machine the window's context is
     * for: a probe mismatch, or an instance other than the one [seen] at the last selection, is a
     * new selection, never an admission that would carry the old instance's session along.
     */
    private fun verdict(route: Route, expected: String?, seen: String?): Pair<Verdict, DirectStatus?> {
        val (probe, status) = try {
            DirectFlow.probeRoute(w.rt, route, expected)
        } catch (e: Exception) {
            w.rt.core.diagnostics.append("machine-view admission probe failed error=${e.javaClass.simpleName}")
            Probe.UNREACHABLE to DirectStatus.Offline
        }
        val verdict = when {
            status is DirectStatus.Yaran && (probe == Probe.MISMATCH || (seen != null && status.instance != seen)) -> Verdict.RESELECT
            status is DirectStatus.Yaran -> Verdict.ADMIT
            status == null -> Verdict.SIGN_IN // an org route with no usable session
            else -> Verdict.REFUSE
        }
        return verdict to status
    }

    private fun act(verdict: Verdict, status: DirectStatus?, then: () -> Unit) = when (verdict) {
        Verdict.ADMIT -> {
            w.admitted = w.openGen
            then()
        }
        Verdict.RESELECT -> select(w.state.chosen, retry = true)
        Verdict.SIGN_IN -> w.onReauthSignal()
        Verdict.REFUSE -> if (orgRoute && status !is DirectStatus.UpgradeRequired) w.showOverlay("offline") else directFailure(status)
    }

    /**
     * A load with no admission from the selection that just ran probes the current route first;
     * a yes admits exactly that load, a too-old build closes the window, an org route with no
     * usable session asks for sign-in, another instance chooses again, anything else is its overlay.
     */
    fun admit(then: () -> Unit) {
        val gen = w.openGen
        val (route, expected, seen) = Triple(w.state.route, w.state.instance, observed)
        w.rt.io.execute {
            val (verdict, status) = verdict(route, expected, seen)
            main.post { if (w.live(gen)) act(verdict, status, then) }
        }
    }

    /**
     * A main-frame document request on the WebView's request thread: the native load just
     * admitted, or one the page started itself (a link, a reload, a form, a new-window target
     * kept in place), which is probed here, synchronously and off the UI thread, before a byte of
     * it loads. False blocks the request; what the probe found is then acted on on the main thread.
     */
    fun admitDocument(url: String): Boolean {
        val gen = w.openGen
        val (route, expected, seen) = Triple(w.state.route, w.state.instance, observed)
        val uri = Uri.parse(url)
        when (uri.scheme?.lowercase()) {
            // Only the route's own origin is a document of it, checked before any pass or probe: another
            // host, another port or plain http (a form posts past shouldOverrideUrlLoading) is blocked
            // here, so nothing is sent to it and no admission of this route is lent to it.
            "https", "http" -> if (!sameOrigin(uri, route.host)) {
                w.rt.core.diagnostics.append("machine-view document for another origin blocked")
                return false
            }
            else -> return true // not fetched from a machine (about:, blob:, data:): the navigation policy's
        }
        if (pass.getAndSet(null) == gen to url.substringBefore('#')) return true
        val (verdict, status) = verdict(route, expected, seen)
        if (verdict == Verdict.ADMIT && w.openGen == gen) return true
        if (verdict != Verdict.ADMIT) main.post { if (w.live(gen)) act(verdict, status) {} }
        return false
    }

    /** `https://<host>` on the default port, exactly: the only origin a route's documents come from. */
    private fun sameOrigin(uri: Uri, host: String) =
        uri.scheme.equals("https", ignoreCase = true) && uri.host?.lowercase() == host && (uri.port == -1 || uri.port == 443)

    private fun needsPassword(s: DirectStatus?) = (s as? DirectStatus.Yaran)?.let { it.requiredHere && !it.signedIn } ?: false

    private fun switchTo(index: Int) {
        if (index == w.state.chosen) return
        w.rt.core.diagnostics.append("machine-view route switch host=${w.state.routes[index].host}")
        // A new origin is a new generation, as a new open is: every read, injection, sheet and
        // renewal the old route started acts on nothing from here (A to B and back to A included).
        w.openGen += 1
        w.dismissDialogs()
        w.state = w.state.switchTo(index)
        observed = null
        w.freshWebView()
    }

    /** Why a lone direct route did not open: a different machine closes, anything else is an overlay. */
    private fun directFailure(s: DirectStatus?) = when (s) {
        is DirectStatus.Yaran -> w.close("error", "instance_changed")
        DirectStatus.AccessRequired -> w.showOverlay("access_on_direct")
        DirectStatus.Redirected -> w.showOverlay("redirected")
        DirectStatus.TlsError -> w.onTlsError()
        DirectStatus.Offline, null -> w.showOverlay("direct_offline")
        DirectStatus.NotYaran, DirectStatus.VaultLocked, is DirectStatus.Refused -> w.showOverlay("not_yaran")
        DirectStatus.UpgradeRequired -> w.close("error", "upgrade_required")
    }

    private fun loadRoute(status: DirectStatus?) {
        if (orgRoute) return w.openOrg()
        settleDirect(status) { w.load(w.state.url) }
    }

    /**
     * Every direct sheet-or-proceed decision. The session is read first ([directReader]: only a
     * record [DirectSession.usable] for the instance observed, any other deleted and its cookies
     * cleared ahead of this callback on the main thread), then the sheet is asked only when no usable
     * session covers what the machine asks for; otherwise [proceed] (a load, or a re-injection).
     */
    private fun settleDirect(status: DirectStatus?, proceed: () -> Unit) {
        w.refreshDirect {
            w.started = true
            if (w.blocked()) return@refreshDirect
            val y = status as? DirectStatus.Yaran
            val own = w.direct?.ownFresh(observed, fresh) == true
            if (!own && (if (y != null) needsPassword(y) else w.direct == null)) {
                w.admitted = null // the sheet comes first; its success selects, and admits, again
                directSignIn()
            } else {
                proceed()
            }
        }
    }

    /**
     * The io-thread read of the window's direct session, for the open [gen] it was asked by:
     * only a record issued by the instance that open observed (captured now, on the main thread).
     * Any other (a machine the user kept after its instance changed) is deleted with every cookie
     * of the host, so nothing of it can reach the new machine; a read that a newer open has
     * overtaken reads nothing and deletes nothing.
     */
    fun directReader(gen: Int): (String) -> DirectSession? {
        val (seen, mine) = observed to fresh
        val owned = { w.live(gen) }
        return { host ->
            if (!owned()) null else w.rt.directSessions.current(host, seen, mine, owned) {
                w.rt.core.diagnostics.append("machine-view direct session from another instance dropped host=$host")
                w.rt.cookies.clearHost(host, storage = false, owned = owned)
            }
        }
    }

    /** The open generation whose password attempt (preflight, sheet, POST) is under way; one at a time. */
    private var signing: Int? = null

    /**
     * The native sheet; on success the route is probed again, so the session is checked against the
     * machine. One attempt per open and route, reserved before its preflight and released by its one
     * ending, so overlapping asks never put up two sheets; a new route or open is a new generation.
     */
    fun directSignIn() {
        val gen = w.openGen
        if (signing == gen) return
        signing = gen
        DirectFlow.signIn(w, w.state.host, owned = { w.live(gen) }, onSheet = { w.sheet = it }) { o ->
            if (signing == gen) signing = null
            if (w.live(gen)) signedIn(o)
        }
    }

    private fun signedIn(o: DirectSignInOutcome) {
        when (o) {
            is DirectSignInOutcome.SignedIn, DirectSignInOutcome.NotRequired -> {
                fresh = (o as? DirectSignInOutcome.SignedIn)?.signInId
                w.hideOverlay()
                select(w.state.chosen, retry = true)
            }
            DirectSignInOutcome.UpgradeRequired -> w.close("error", "upgrade_required")
            else -> {
                val code = when (o) {
                    is DirectSignInOutcome.ServerRefused -> mapOf("code" to o.code)
                    is DirectSignInOutcome.Refused -> mapOf("code" to o.reason)
                    else -> emptyMap()
                }
                val detail = Messages.direct[o.kind]?.let { Messages.fill(it, w.vars() + code) }
                val server = (o.toJs()["message"] as? String)?.takeIf { it.isNotEmpty() }
                w.showDetail(listOfNotNull(detail, server).joinToString("\n\n").ifEmpty { null })
            }
        }
    }

    /** The current route's credential again, with no reload (resume of a healthy page). */
    fun reinject() {
        if (orgRoute) return w.resumeOrg()
        w.refreshDirect { injectDirect() }
    }

    /** The window's current direct session as its cookie, for this open only. */
    private fun injectDirect() {
        val gen = w.openGen
        w.direct?.setCookie()?.let { w.rt.cookies.inject(w.state.host, it, owned = { w.live(gen) }) {} }
    }
}
