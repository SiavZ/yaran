/**
 * The machine window: one machine's yaran web UI in a bridge-less WebView, pinned to its host.
 *
 * Owns the lifecycle the Phase 15 configuration table describes: cookie injection before
 * every load and on resume, pre-open and resume renewal through the system-browser handoff
 * (org routes; direct routes, route choice and target replacement are [RouteDriver]'s), shared
 * files ([ShareChooser]), the banner and overlays, back through WebView history, saved state,
 * the lock cover and `FLAG_SECURE`, renderer-crash recovery, and pausing the WebView (so the
 * page reports itself hidden) whenever the window is paused or covered. `singleTask` and
 * `configChanges` keep one machine at a time and never recreate the page on rotation or resize.
 *
 * - Main thread; vault reads and probes go through the runtime's io executor. A stored session
 *   that is there but unreadable is said so, never treated as signed out.
 * - Emits exactly one `closed` event per window through [MachineViewPlugin].
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.machineview.MachineViewActivity
 * ├── io.github.siavz.yaran.machineview.BrowserLauncher (inferred)
 * ├── io.github.siavz.yaran.machineview.CallbackUrl (inferred)
 * ├── io.github.siavz.yaran.machineview.CookieSpec (inferred)
 * ├── io.github.siavz.yaran.machineview.Direct (inferred)
 * ├── io.github.siavz.yaran.machineview.Fallbacks (inferred)
 * ├── io.github.siavz.yaran.machineview.HandoffClient (inferred)
 * ├── io.github.siavz.yaran.machineview.InsetsController (inferred)
 * ├── io.github.siavz.yaran.machineview.InsetsMode (inferred)
 * ├── io.github.siavz.yaran.machineview.MachineChromeClient (inferred)
 * ├── io.github.siavz.yaran.machineview.MachineState (inferred)
 * ├── io.github.siavz.yaran.machineview.MachineViewPlugin (inferred)
 * ├── io.github.siavz.yaran.machineview.MachineWebViewClient (inferred)
 * ├── io.github.siavz.yaran.machineview.MachineWebViewFactory (inferred)
 * ├── io.github.siavz.yaran.machineview.Messages (inferred)
 * ├── io.github.siavz.yaran.machineview.NavigationPolicy (inferred)
 * ├── io.github.siavz.yaran.machineview.Outcomes (inferred)
 * ├── io.github.siavz.yaran.machineview.OverlayView (inferred)
 * ├── io.github.siavz.yaran.machineview.PluginRuntime (inferred)
 * ├── io.github.siavz.yaran.machineview.RefusalPolicy (inferred)
 * ├── io.github.siavz.yaran.machineview.RenewalCoordinator (inferred)
 * ├── io.github.siavz.yaran.machineview.RouteDriver (inferred)
 * ├── io.github.siavz.yaran.machineview.SessionReads (inferred)
 * ├── io.github.siavz.yaran.machineview.SessionStore (inferred)
 * ├── io.github.siavz.yaran.machineview.ShareChooser (inferred)
 * └── io.github.siavz.yaran.machineview.WindowEvents (inferred)
 * External: android.content, android.net, android.os, android.view, android.view.ViewGroup.LayoutParams, android.webkit, android.widget, androidx.activity, androidx.activity.result.contract, androidx.appcompat.app, androidx.core.view, androidx.webkit, java.lang.ref
 *
 * Used by:
 * io.github.siavz.yaran.machineview.MachineViewActivity
 * ├── io.github.siavz.yaran.machineview.AbandonedLoginRobolectricTest (inferred)
 * ├── io.github.siavz.yaran.machineview.AdmissionRobolectricTest (inferred)
 * ├── io.github.siavz.yaran.machineview.DirectWindowRobolectricTest (inferred)
 * ├── io.github.siavz.yaran.machineview.FreshSignInRobolectricTest (inferred)
 * ├── io.github.siavz.yaran.machineview.MachineViewPlugin (inferred)
 * ├── io.github.siavz.yaran.machineview.MachineWindowRobolectricTest (inferred)
 * ├── io.github.siavz.yaran.machineview.RouteDriver (inferred)
 * ├── io.github.siavz.yaran.machineview.SessionGenerationRobolectricTest (inferred)
 * ├── io.github.siavz.yaran.machineview.ShareChooser (inferred)
 * ├── io.github.siavz.yaran.machineview.StaleOpenRobolectricTest (inferred)
 * ├── io.github.siavz.yaran.machineview.UpgradeRequiredRobolectricTest (inferred)
 * ├── io.github.siavz.yaran.machineview.WindowEvents (inferred)
 * ├── io.github.siavz.yaran.machineview.WindowRepairRobolectricTest (inferred)
 * └── io.github.siavz.yaran.machineview.WindowRound12RobolectricTest (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.SystemClock
import android.view.Gravity
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.view.WindowManager
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.webkit.WebViewCompat
import java.lang.ref.WeakReference

class MachineViewActivity : AppCompatActivity(), MachineWindow, RenewalUi {
    internal lateinit var rt: PluginRuntime
    internal lateinit var state: MachineState
    override val host: String get() = state.host
    private lateinit var root: FrameLayout
    internal var web: WebView? = null
    internal lateinit var overlay: OverlayView
    private lateinit var banner: OverlayView
    private lateinit var shareBanner: OverlayView
    private lateinit var cover: OverlayView
    private lateinit var launcher: BrowserLauncher
    internal lateinit var coordinator: RenewalCoordinator
    internal lateinit var share: ShareChooser
    private val timer = MainTimer()
    @Volatile private var session: Session? = null
    @Volatile internal var direct: DirectSession? = null
    private var read = Read.MISSING
    internal var startRequested = false
    internal var started = false
    private var lockPrompted = false
    internal var reloadAtUnlock = false
    private var resumed = false
    internal var pausedAt: Long? = null
    internal var closedEmitted = false

    /** One per open target: a continuation of an older one (a read, an injection, a sign-in) does nothing. */
    @Volatile internal var openGen = 0 // read on the io thread too: stale work stops before it acts
    /** The generation whose probe just found the current route's yaran able to show its page here; one load spends it. */
    internal var admitted: Int? = null
    internal var sheet: android.app.AlertDialog? = null
    private var chooserCallback: ((Array<Uri>?) -> Unit)? = null

    private val chooser = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val uris = result.data?.let { d -> d.clipData?.let { c -> Array(c.itemCount) { c.getItemAt(it).uri } } ?: d.data?.let { arrayOf(it) } }
        chooserCallback?.invoke(if (result.resultCode == RESULT_OK) uris else null)
        chooserCallback = null
    }

    internal val backCallback = object : OnBackPressedCallback(false) {
        override fun handleOnBackPressed() {
            // Under the lock cover, back leaves the window instead of driving the page behind it.
            if (cover.shown != null) close("user", null) else web?.goBack()
        }
    }

    internal val orgOnly get() = state.kind == OpenKind.ORG
    internal val orgRoute get() = state.route is Route.Org
    internal val routes = RouteDriver(this)
    private val reads = SessionReads({ rt }, { host })

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        launcher = BrowserLauncher(this)
        val parsed = savedInstanceState?.let { MachineState.fromBundle(it) } ?: MachineState.fromIntent(intent)
        rt = try {
            PluginRuntime.get(this)
        } catch (e: IllegalStateException) {
            return close("error", "core_missing")
        }
        state = parsed ?: return close("error", "invalid_arguments")
        current = WeakReference(this)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        root = FrameLayout(this)
        overlay = OverlayView(this, banner = false, ::overlayAction)
        banner = OverlayView(this, banner = true, ::overlayAction)
        shareBanner = OverlayView(this, banner = true, ::overlayAction)
        cover = OverlayView(this, banner = false) { if (it == "unlock") unlockApp() }
        root.addView(overlay, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        root.addView(banner, FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
        root.addView(shareBanner, FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT, Gravity.BOTTOM))
        root.addView(cover, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        share = ShareChooser(this) { n -> if (n > 0) shareBanner.show("share_ready", vars() + ("count" to n.toString())) else shareBanner.hide() }
        attachWebView()
        setContentView(root)
        share.take(intent, restored = savedInstanceState != null)
        val version = WebViewCompat.getCurrentWebViewPackage(this)?.versionName
        InsetsController.apply(root, InsetsMode.forWebViewVersion(version, Fallbacks.FORCE_PADDING_INSETS))
        onBackPressedDispatcher.addCallback(this, backCallback)
        coordinator = RenewalCoordinator({ session }, { System.currentTimeMillis() / 1000 }, timer, this) { done ->
            val orgId = state.orgId ?: return@RenewalCoordinator done(SignInOutcome.Cancelled) // direct routes never renew here
            val gen = openGen
            SignInFlow.start(this, launcher, orgId, SignInTarget.Machine(host)) { o ->
                if (!live(gen)) return@start
                if (o is SignInOutcome.SignedIn) refreshSession { done(o) } else {
                    done(o)
                    showSignInFailure(o)
                }
            }
        }
        // A window restored while locked (process death) starts only after the cover's unlock.
        if (!rt.core.appLock.isLocked()) start()
    }

    internal fun start() {
        if (startRequested) return
        startRequested = true
        if (orgOnly) openOrg() else routes.select(null, retry = false)
    }

    /** An org route's open: the stored session, then renewal or the load (Phase 15). */
    internal fun openOrg() = refreshSession {
        started = true
        if (blocked()) return@refreshSession
        if (coordinator.onOpen()) {
            onReauthSignal()
            coordinator.renewNow { }
        } else {
            load(state.url)
            coordinator.evaluate()
        }
    }

    /** A locked or unreadable session stops here with its own cover or overlay; true when it did. */
    internal fun blocked(): Boolean = when (read) {
        Read.LOCKED -> {
            admitted = null
            startRequested = started // a start cut short by the lock runs again at the unlock
            showLockCover()
            true
        }
        Read.UNREADABLE -> {
            admitted = null
            showOverlay("session_unreadable")
            true
        }
        Read.FOUND, Read.MISSING -> false
    }

    /** A new origin gets a new WebView: nothing of the old page, history or renderer survives. */
    internal fun freshWebView() {
        web?.let {
            root.removeView(it)
            it.destroy()
        }
        web = null
        timer.schedule(null) {}
        session = null
        direct = null
        overlay.hide()
        banner.hide()
        attachWebView()
    }

    // --- sessions ------------------------------------------------------------------------

    /** Only a session of this route's own org; another org's session for the same host is no session. */
    private fun refreshSession(then: () -> Unit) = state.orgId.let { org -> val gen = openGen; reads.read({ rt.sessions.get(it)?.takeIf { s -> s.orgId == org } }) { r, s ->
        if (!live(gen)) return@read
        read = r
        session = s
        then()
    } }

    internal fun refreshDirect(then: () -> Unit) = openGen.let { gen -> reads.read(routes.directReader(gen)) { r, s ->
        if (!live(gen)) return@read
        read = r
        direct = s
        then()
    } }

    private fun attachWebView() {
        val w = MachineWebViewFactory.create(this, rt.webViewDebug, rt.uaToken)
        w.webViewClient = MachineWebViewClient(this)
        w.webChromeClient = MachineChromeClient({ intent, cb ->
            chooserCallback = cb
            try {
                chooser.launch(intent)
                true
            } catch (e: ActivityNotFoundException) {
                chooserCallback = null
                false
            }
        }, share::offer)
        w.setDownloadListener { _, _, _, _, _ -> toast(Messages.overlay.getValue("download_refused").message) }
        if (::cover.isInitialized && cover.shown != null) w.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        root.addView(w, 0, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        web = w
        syncPageVisibility() // a page recreated under the cover starts hidden
    }

    /**
     * The page is document-visible, and so sends the viewed beat that holds back attention and
     * pushes for its tab, only while this window is resumed with no lock cover up and the app
     * unlocked. A paused WebView reports itself hidden whatever its window does.
     */
    private fun syncPageVisibility() {
        val w = web ?: return
        if (resumed && cover.shown == null && !rt.core.appLock.isLocked()) w.onResume() else w.onPause()
    }

    /** Loads [url] with only the current route's own credential injected first. */
    internal fun load(url: String) {
        if (admitted != openGen) return routes.admit { load(url) }
        admitted = null
        val gen = openGen
        if (!orgRoute) {
            val line = direct?.setCookie() ?: return enter(url)
            return rt.cookies.inject(host, line, owned = { live(gen) }) { ok -> if (!live(gen)) Unit else if (ok) enter(url) else onReauthSignal() }
        }
        val s = session ?: return onReauthSignal()
        val c = CookieSpec.setCookie(s.jwt, s.cookie, s.credentialKind) ?: return onReauthSignal()
        if (c.diagnostic) rt.core.diagnostics.append("machine-view cookie rung fell back to the jwt host=$host")
        rt.cookies.inject(host, c.setCookie, owned = { live(gen) }) { ok -> if (!live(gen)) Unit else if (ok) enter(url) else onReauthSignal() }
    }

    private fun enter(url: String) {
        routes.pass(url)
        reloadAtUnlock = false // the navigation is really submitted: only this settles a reload a lost renderer owed
        web?.loadUrl(url)
    }

    override fun admitDocument(url: String) = routes.admitDocument(url)

    override fun onResume() {
        super.onResume()
        resumed = true
        if (!::rt.isInitialized || !::state.isInitialized) return
        applyPrivacy()
        // The lock is app-wide (AppLock.trackActivities): it may have engaged while this window was away.
        if (rt.core.appLock.isLocked()) return showLockCover()
        syncPageVisibility()
        resumeSession()
    }

    private fun showLockCover() {
        cover.showText(Messages.signIn.getValue("vault_locked").message, listOf("unlock"))
        underCover(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS)
        syncPageVisibility()
        if (!lockPrompted) {
            lockPrompted = true
            unlockApp()
        }
    }

    private fun unlockApp() = rt.core.appLock.unlock(this) {
        if (rt.core.appLock.isLocked() || isFinishing) return@unlock
        hideLockCover()
        resumeSession()
    }

    private fun hideLockCover() {
        lockPrompted = false
        cover.hide()
        underCover(View.IMPORTANT_FOR_ACCESSIBILITY_AUTO)
        syncPageVisibility() // an unlock that lands while paused waits for onResume
    }

    /** The page, overlays and banners under the cover: TalkBack must not reach their Sign in or Renew. */
    private fun underCover(importance: Int) {
        listOfNotNull(web, overlay, banner, shareBanner).forEach { it.importantForAccessibility = importance }
    }

    private fun resumeSession() {
        if (SignInFlow.inFlight()) return SignInFlow.onCancelSoon(this)
        if (!started) return start()
        val away = pausedAt?.let { SystemClock.elapsedRealtime() - it } ?: 0L
        pausedAt = null
        when {
            orgOnly -> resumeOrg()
            // The page's sockets parked while it was away: its routes are probed again, the current one first; a
            // renderer lost under the lock still gets its one reload, on whichever route answers.
            away >= PARKED_MS -> routes.select(state.chosen, retry = reloadAtUnlock)
            reloadAtUnlock -> load(state.url)
            else -> routes.reinject()
        }
    }

    internal fun resumeOrg() = refreshSession {
        if (blocked()) return@refreshSession
        if (coordinator.onResume()) {
            onReauthSignal()
            coordinator.renewNow { }
        } else if (reloadAtUnlock) {
            load(state.url)
        } else {
            session?.let { s -> CookieSpec.setCookie(s.jwt, s.cookie, s.credentialKind)?.let { val g = openGen; rt.cookies.inject(host, it.setCookie, owned = { live(g) }) {} } }
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus && ::rt.isInitialized && !rt.core.appLock.isLocked() && cover.shown != null) hideLockCover()
    }

    override fun onPause() {
        super.onPause()
        resumed = false
        pausedAt = SystemClock.elapsedRealtime()
        syncPageVisibility()
        if (started) coordinator.onVisibilityChanged(false)
    }

    private fun applyPrivacy() {
        if (rt.core.screenPrivacy.enabled()) window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        else window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
    }

    /** An open while this window is up (singleTask, or singleTop in debug) replaces its target ([RouteDriver.replace]). */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        MachineState.fromIntent(intent)?.let { routes.replace(it, intent) }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        if (::state.isInitialized) state.toBundle(outState)
    }

    internal fun live(gen: Int) = gen == openGen && !isFinishing && !isDestroyed

    /** The password sheet and the share confirm of a target that is going: dismissed, their callbacks settled. */
    internal fun dismissDialogs() {
        sheet?.dismiss()
        sheet = null
        if (::share.isInitialized) share.cancelConfirm()
        chooserCallback?.invoke(null)
        chooserCallback = null
    }

    override fun onDestroy() {
        dismissDialogs()
        timer.schedule(null) {}
        web?.destroy()
        web = null
        if (isFinishing && !isChangingConfigurations) emitClosed("user", null)
        if (current?.get() === this) current = null
        super.onDestroy()
    }

    // --- MachineWindow -------------------------------------------------------------------

    override fun onNavigation(decision: NavDecision, url: String) = navigate(decision, url)

    override fun onRefusal(decision: RefusalDecision, code: String?) = refused(decision, code)

    override fun onTlsError() {
        rt.core.diagnostics.append("machine-view tls error host=$host")
        showOverlay("tls_error")
    }

    override fun onLoadFailed() = showOverlay(if (state.routes.size > 1) "offline_routes" else if (orgRoute) "offline" else "direct_offline")

    override fun onRendererGone(view: WebView) {
        rt.core.diagnostics.append("machine-view renderer gone host=$host")
        root.removeView(view)
        view.destroy()
        if (web === view) web = null
        attachWebView()
        reloadAtUnlock = true // owed until a navigation is really submitted ([enter]), even if this load fails
        if (!rt.core.appLock.isLocked() && cover.shown == null) load(state.url)
        toast(Messages.overlay.getValue("renderer_crashed").message)
    }

    override fun onHistoryChanged(url: String) {
        if (MachineState.keepUrl(host, url)) state = state.copy(url = url)
        backCallback.isEnabled = web?.canGoBack() == true
    }

    override fun showBanner() = banner.show("banner", vars())

    override fun hideBanner() = banner.hide()

    override fun showReauthOverlay() = showOverlay("reauth")

    override fun hideOverlay() = overlay.hide()

    /** After a renewal: a routed window checks the route's instance again before anything loads. */
    override fun reloadSameUrl() = if (state.kind == OpenKind.ROUTES) routes.select(state.chosen, retry = true) else load(state.url)

    internal fun onReauthSignal() = if (orgRoute && ::coordinator.isInitialized) coordinator.onReauthSignal() else showOverlay("reauth")

    private fun showSignInFailure(o: SignInOutcome) = Messages.signIn[o.kind]?.let {
        showDetail(Messages.fill(it.message, vars() + ((o as? SignInOutcome.Refused)?.code?.let { c -> mapOf("code" to c) } ?: emptyMap())))
    }

    internal fun showDetail(detail: String?) = overlay.show("reauth", vars(), detail)

    internal fun showOverlay(kind: String, code: String? = null) {
        overlay.show(kind, vars() + (code?.let { mapOf("code" to it) } ?: emptyMap()))
    }

    internal fun vars(): Map<String, String> =
        mapOf("host" to host, "machine" to host) + (session?.email?.let { mapOf("email" to it) } ?: emptyMap()) +
            ((rt.mode as? CallbackMode.Https)?.let { mapOf("domain" to it.domain) } ?: emptyMap())

    internal fun toast(message: String) = Toast.makeText(this, message, Toast.LENGTH_LONG).show()

    internal fun close(reason: String, code: String?) {
        dismissDialogs()
        emitClosed(reason, code)
        finish()
    }

    internal fun emitClosed(reason: String, code: String?) {
        if (closedEmitted) return
        closedEmitted = true
        val s = if (::state.isInitialized) state else null
        closedWith = MachineViewPlugin.closedEvent(reason, code, s?.host?.takeIf { code != "no_route" }, s?.routes?.first()?.host)
        MachineViewPlugin.emit(closedWith!!)
    }

    /** The `closed` event this window sent (tests read it; there is no plugin in a unit test). */
    internal var closedWith: Map<String, Any?>? = null

    companion object {
        @Volatile internal var current: WeakReference<MachineViewActivity>? = null

        /** The intent carries shared files in its ClipData (G5). */
        const val K_SHARE = "share"

        /** Away this long, the page's sockets have parked, so a routed window may pick a route again. */
        const val PARKED_MS = 30_000L
    }
}
