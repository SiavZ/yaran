/**
 * The machine window: one machine's yaran web UI in a bridge-less WebView, pinned to its host.
 *
 * Owns the lifecycle the Phase 15 configuration table describes: cookie injection before
 * every load and on resume, pre-open and resume renewal through the system-browser handoff,
 * the banner and overlays, back through WebView history (predictive back when there is none),
 * saved state, the lock cover and `FLAG_SECURE`, and renderer-crash recovery. `singleTask`
 * and `configChanges` keep one machine at a time and never recreate the page on rotation,
 * resize or a theme change.
 *
 * - Main thread; vault reads go through the runtime's io executor.
 * - Emits exactly one `closed` event per window through [MachineViewPlugin].
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.machineview.MachineViewActivity
 * ├── io.github.siavz.yaran.machineview.BrowserLauncher (inferred)
 * ├── io.github.siavz.yaran.machineview.CallbackUrl (inferred)
 * ├── io.github.siavz.yaran.machineview.CookieSpec (inferred)
 * ├── io.github.siavz.yaran.machineview.CoreBindings (inferred)
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
 * ├── io.github.siavz.yaran.machineview.SessionStore (inferred)
 * └── io.github.siavz.yaran.machineview.UrlParts (inferred)
 * External: android.content, android.net, android.os, android.view, android.view.ViewGroup.LayoutParams, android.webkit, android.widget, androidx.activity, androidx.activity.result.contract, androidx.appcompat.app, androidx.browser.customtabs, androidx.core.view, androidx.webkit, java.lang.ref
 *
 * Used by:
 * io.github.siavz.yaran.machineview.MachineViewActivity
 * ├── io.github.siavz.yaran.machineview.MachineViewPlugin (inferred)
 * └── io.github.siavz.yaran.machineview.MachineWindowRobolectricTest (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.view.WindowManager
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.browser.customtabs.CustomTabsIntent
import androidx.core.view.WindowCompat
import androidx.webkit.WebViewCompat
import java.lang.ref.WeakReference

class MachineViewActivity : AppCompatActivity(), MachineWindow, RenewalUi {
    private lateinit var rt: PluginRuntime
    private lateinit var state: MachineState
    override val host: String get() = state.host
    private lateinit var root: FrameLayout
    private var web: WebView? = null
    private lateinit var overlay: OverlayView
    private lateinit var banner: OverlayView
    private lateinit var cover: OverlayView
    private lateinit var launcher: BrowserLauncher
    private lateinit var coordinator: RenewalCoordinator
    private val main = Handler(Looper.getMainLooper())
    private var timer: Runnable? = null
    @Volatile private var session: Session? = null
    private var started = false
    private var closedEmitted = false
    private var chooserCallback: ((Array<Uri>?) -> Unit)? = null

    private val chooser = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val uris = result.data?.let { d -> d.clipData?.let { c -> Array(c.itemCount) { c.getItemAt(it).uri } } ?: d.data?.let { arrayOf(it) } }
        chooserCallback?.invoke(if (result.resultCode == RESULT_OK) uris else null)
        chooserCallback = null
    }

    internal val backCallback = object : OnBackPressedCallback(false) {
        override fun handleOnBackPressed() {
            web?.goBack()
        }
    }

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
        overlay = OverlayView(this, banner = false, ::onOverlayAction)
        banner = OverlayView(this, banner = true, ::onOverlayAction)
        cover = OverlayView(this, banner = false) {}
        root.addView(overlay, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        root.addView(banner, FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
        root.addView(cover, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        attachWebView()
        setContentView(root)
        val version = WebViewCompat.getCurrentWebViewPackage(this)?.versionName
        InsetsController.apply(root, InsetsMode.forWebViewVersion(version, Fallbacks.FORCE_PADDING_INSETS))
        onBackPressedDispatcher.addCallback(this, backCallback)
        coordinator = RenewalCoordinator({ session }, ::nowSeconds, ::schedule, this) { done ->
            SignInFlow.start(this, launcher, state.orgId, SignInTarget.Machine(host)) { o ->
                if (o is SignInOutcome.SignedIn) refreshSession { done(o) } else {
                    done(o)
                    showSignInFailure(o)
                }
            }
        }
        refreshSession {
            started = true
            if (coordinator.onOpen()) {
                onReauthSignal()
                coordinator.renewNow { }
            } else {
                load(state.url)
                coordinator.evaluate()
            }
        }
    }

    private fun attachWebView() {
        val w = MachineWebViewFactory.create(this, rt.webViewDebug, rt.uaToken)
        w.webViewClient = MachineWebViewClient(this)
        w.webChromeClient = MachineChromeClient { intent, cb ->
            chooserCallback = cb
            try {
                chooser.launch(intent)
                true
            } catch (e: ActivityNotFoundException) {
                chooserCallback = null
                false
            }
        }
        w.setDownloadListener { _, _, _, _, _ -> toast(Messages.overlay.getValue("download_refused").message) }
        root.addView(w, 0, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        web = w
    }

    private fun refreshSession(then: () -> Unit) {
        rt.io.execute {
            val s = try {
                rt.sessions.get(host)
            } catch (e: VaultLockedException) {
                null
            }
            main.post {
                session = s
                then()
            }
        }
    }

    private fun load(url: String) {
        val s = session ?: return onReauthSignal()
        val c = CookieSpec.setCookie(s.jwt, s.cookie, s.credentialKind) ?: return onReauthSignal()
        if (c.diagnostic) rt.core.diagnostics.append("machine-view cookie rung fell back to the jwt host=$host")
        rt.cookies.inject(host, c.setCookie) { ok ->
            if (ok) web?.loadUrl(url) else onReauthSignal()
        }
    }

    override fun onResume() {
        super.onResume()
        if (!::rt.isInitialized || !::state.isInitialized) return
        applyPrivacy()
        if (rt.core.appLock.isLocked()) cover.showText(Messages.signIn.getValue("vault_locked").message)
        if (SignInFlow.inFlight()) return SignInFlow.onCancelSoon(this)
        if (!started) return
        refreshSession {
            if (coordinator.onResume()) {
                onReauthSignal()
                coordinator.renewNow { }
            } else {
                session?.let { s -> CookieSpec.setCookie(s.jwt, s.cookie, s.credentialKind)?.let { rt.cookies.inject(host, it.setCookie) {} } }
            }
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus && ::rt.isInitialized && !rt.core.appLock.isLocked() && cover.shown != null) cover.hide()
    }

    override fun onPause() {
        super.onPause()
        if (started) coordinator.onVisibilityChanged(false)
    }

    private fun applyPrivacy() {
        if (rt.core.screenPrivacy.enabled()) window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        else window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        if (::state.isInitialized) state.toBundle(outState)
    }

    override fun onDestroy() {
        timer?.let { main.removeCallbacks(it) }
        web?.destroy()
        web = null
        if (isFinishing && !isChangingConfigurations) emitClosed("user", null)
        if (current?.get() === this) current = null
        super.onDestroy()
    }

    // --- MachineWindow -------------------------------------------------------------------

    override fun onNavigation(decision: NavDecision, url: String) {
        when (decision.action) {
            NavAction.REAUTH -> onReauthSignal()
            NavAction.CLOSE_HOME -> close("home", null)
            NavAction.CLOSE_SETTINGS -> close("settings", null)
            NavAction.EXTERNAL -> openExternally(url)
            NavAction.BLOCK, NavAction.IGNORE, NavAction.ALLOW, NavAction.ALLOW_IN_PLACE -> Unit
        }
        if (decision.diagnostic) {
            val scheme = UrlParts.parse(url)?.scheme ?: "unparseable"
            rt.core.diagnostics.append("machine-view navigation ${decision.action.name.lowercase()} scheme=$scheme")
        }
    }

    override fun onRefusal(decision: RefusalDecision, code: String?) {
        val safe = code?.takeIf { Regex("^[a-z0-9-]{1,64}$").matches(it) } ?: "invalid"
        if (decision.diagnostic) rt.core.diagnostics.append("machine-view unknown refusal code=$safe host=$host")
        when (decision.overlay) {
            RefusalOverlay.REAUTH -> onReauthSignal()
            RefusalOverlay.NOT_OWNER -> showOverlay("not_owner")
            RefusalOverlay.KEYS_UNAVAILABLE -> showOverlay("keys_unavailable")
            RefusalOverlay.UNAVAILABLE -> showOverlay("unavailable")
            RefusalOverlay.HOST_DISCONNECTED -> showOverlay("host_disconnected")
            RefusalOverlay.CODE_OVERLAY -> showOverlay("code_overlay", safe)
            RefusalOverlay.OFFLINE -> showOverlay("offline")
            RefusalOverlay.NONE -> Unit
        }
    }

    override fun onTlsError() {
        rt.core.diagnostics.append("machine-view tls error host=$host")
        showOverlay("tls_error")
    }

    override fun onLoadFailed() = showOverlay("offline")

    override fun onRendererGone(view: WebView) {
        rt.core.diagnostics.append("machine-view renderer gone host=$host")
        root.removeView(view)
        view.destroy()
        if (web === view) web = null
        attachWebView()
        load(state.url)
        toast(Messages.overlay.getValue("renderer_crashed").message)
    }

    override fun onHistoryChanged(url: String) {
        if (MachineState.keepUrl(host, url)) state = state.copy(url = url)
        backCallback.isEnabled = web?.canGoBack() == true
    }

    // --- RenewalUi -----------------------------------------------------------------------

    override fun showBanner() = banner.show("banner", vars())

    override fun hideBanner() = banner.hide()

    override fun showReauthOverlay() = showOverlay("reauth")

    override fun hideOverlay() = overlay.hide()

    override fun reloadSameUrl() = load(state.url)

    // --- helpers -------------------------------------------------------------------------

    private fun onReauthSignal() = if (::coordinator.isInitialized) coordinator.onReauthSignal() else showOverlay("reauth")

    private fun onOverlayAction(action: String) {
        when (action) {
            "sign_in", "renew" -> coordinator.renewNow { }
            "back_to_machines" -> close("user", null)
            "retry" -> {
                overlay.hide()
                load(state.url)
            }
        }
    }

    private fun showSignInFailure(o: SignInOutcome) {
        val row = Messages.signIn[o.kind] ?: return
        val detail = Messages.fill(row.message, vars() + ((o as? SignInOutcome.Refused)?.code?.let { mapOf("code" to it) } ?: emptyMap()))
        overlay.show("reauth", vars(), detail)
    }

    private fun showOverlay(kind: String, code: String? = null) {
        overlay.show(kind, vars() + (code?.let { mapOf("code" to it) } ?: emptyMap()))
    }

    private fun vars(): Map<String, String> =
        mapOf("host" to host, "machine" to host) + (session?.email?.let { mapOf("email" to it) } ?: emptyMap()) +
            ((rt.mode as? CallbackMode.Https)?.let { mapOf("domain" to it.domain) } ?: emptyMap())

    private fun openExternally(url: String) {
        val uri = Uri.parse(url)
        try {
            if (uri.scheme == "https" || uri.scheme == "http") CustomTabsIntent.Builder().build().launchUrl(this, uri)
            else startActivity(Intent(if (uri.scheme == "tel") Intent.ACTION_DIAL else Intent.ACTION_SENDTO, uri))
        } catch (e: ActivityNotFoundException) {
            rt.core.diagnostics.append("machine-view no app for an external ${uri.scheme} link")
        }
    }

    private fun schedule(at: Long?, task: () -> Unit) {
        timer?.let { main.removeCallbacks(it) }
        timer = null
        if (at == null) return
        val r = Runnable { task() }
        timer = r
        main.postDelayed(r, maxOf(0L, (at - nowSeconds()) * 1000))
    }

    private fun nowSeconds() = System.currentTimeMillis() / 1000

    private fun toast(message: String) = Toast.makeText(this, message, Toast.LENGTH_LONG).show()

    internal fun close(reason: String, code: String?) {
        emitClosed(reason, code)
        finish()
    }

    private fun emitClosed(reason: String, code: String?) {
        if (closedEmitted) return
        closedEmitted = true
        MachineViewPlugin.emitClosed(reason, code)
    }

    companion object {
        @Volatile internal var current: WeakReference<MachineViewActivity>? = null
    }
}
