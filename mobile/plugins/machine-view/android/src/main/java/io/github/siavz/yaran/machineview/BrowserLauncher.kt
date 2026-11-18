/**
 * Opens the handoff URL in the system browser and routes its ending back to the handoff client.
 *
 * Auth Tab when the default Custom Tabs browser supports it (release: `launch(…, host, path)`
 * so the redirect returns only after Digital Asset Links verification; dev: the custom
 * scheme), else a plain Custom Tab whose redirect reaches [AuthCallbackActivity]. No browser
 * means the no-browser outcome. Never ephemeral, so IdP and consent cookies are reused (D24).
 * [SignInFlow] holds the one waiting caller and the 3-second grace after a cancel or a bare
 * return, in which a redirect delivered through an intent still wins.
 *
 * - Main thread. The launcher must be registered before the activity is STARTED.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.machineview.BrowserLauncher
 * ├── io.github.siavz.yaran.machineview.CallbackUrl (inferred)
 * ├── io.github.siavz.yaran.machineview.HandoffClient (inferred)
 * ├── io.github.siavz.yaran.machineview.Outcomes (inferred)
 * └── io.github.siavz.yaran.machineview.PluginRuntime (inferred)
 * External: android.content, android.net, android.os, androidx.activity, androidx.activity.result, androidx.browser.auth, androidx.browser.customtabs
 *
 * Used by:
 * io.github.siavz.yaran.machineview.BrowserLauncher
 * ├── io.github.siavz.yaran.machineview.AuthCallbackActivity (inferred)
 * ├── io.github.siavz.yaran.machineview.AuthTabRegistryRobolectricTest (inferred)
 * ├── io.github.siavz.yaran.machineview.MachineViewActivity (inferred)
 * └── io.github.siavz.yaran.machineview.SessionPlugin (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResultLauncher
import androidx.browser.auth.AuthTabIntent
import androidx.browser.customtabs.CustomTabsClient
import androidx.browser.customtabs.CustomTabsIntent

internal class BrowserLauncher(private val activity: ComponentActivity) {
    /** One registry entry per Auth Tab launch, keyed by that launch's state: its result is its own. */
    private val registered = mutableMapOf<String, ActivityResultLauncher<Intent>>()

    init {
        // A recreated activity (or a restarted process, through the handoff marker) gets the
        // result of the launch still awaited back under that launch's own key.
        runCatching { PluginRuntime.get(activity).handoff.awaitedState() }.getOrNull()?.let(::authTab)
    }

    /**
     * The Auth Tab launcher for the launch named [state]. AndroidX routes each result to the
     * entry its request was made through, whatever order results arrive in, so an ending is
     * always told which launch it belongs to; the entry goes once it answered.
     */
    internal fun authTab(state: String): ActivityResultLauncher<Intent> = registered.getOrPut(state) {
        activity.activityResultRegistry.register(KEY + state, AuthTabIntent.AuthenticateUserResultContract()) { result ->
            registered.remove(state)?.unregister()
            SignInFlow.onAuthTabResult(activity, state, result)
        }
    }

    fun launch(url: String, mode: CallbackMode, state: String) {
        val uri = Uri.parse(url)
        try {
            when (val browser = detect(activity)) {
                is Browser.AuthTab -> {
                    val tab = AuthTabIntent.Builder().build()
                    tab.intent.setPackage(browser.pkg)
                    when (mode) {
                        is CallbackMode.Https -> tab.launch(authTab(state), uri, mode.domain, CALLBACK_PATH)
                        CallbackMode.Dev -> tab.launch(authTab(state), uri, DEV_SCHEME)
                    }
                }
                is Browser.CustomTab -> CustomTabsIntent.Builder().build().apply { intent.setPackage(browser.pkg) }.launchUrl(activity, uri)
                Browser.None -> SignInFlow.onNoBrowser(activity, state)
            }
        } catch (e: ActivityNotFoundException) {
            registered.remove(state)?.unregister()
            SignInFlow.onNoBrowser(activity, state)
        }
    }

    companion object {
        const val CALLBACK_PATH = "/auth/callback"
        const val DEV_SCHEME = "yaranapp"
        private const val KEY = "io.github.siavz.yaran.authTab#"

        /** The default Custom Tabs browser and what it supports; a var only so tests can pick one. */
        internal var detect: (Context) -> Browser = { ctx ->
            val pkg = CustomTabsClient.getPackageName(ctx, null)
            when {
                pkg == null -> Browser.None
                CustomTabsClient.isAuthTabSupported(ctx, pkg) -> Browser.AuthTab(pkg)
                else -> Browser.CustomTab(pkg)
            }
        }
    }

    internal sealed interface Browser {
        data class AuthTab(val pkg: String) : Browser
        data class CustomTab(val pkg: String) : Browser
        data object None : Browser
    }
}

/** The one in-flight sign-in of this process and the caller waiting for its outcome. */
internal object SignInFlow {
    private const val GRACE_MS = 3_000L
    private val main = Handler(Looper.getMainLooper())
    private var waiting: ((SignInOutcome) -> Unit)? = null
    private var generation = 0

    /** Begins a handoff (off the main thread) and launches the browser; [done] runs on the main thread. */
    fun start(activity: ComponentActivity, launcher: BrowserLauncher, orgId: String, target: SignInTarget, done: (SignInOutcome) -> Unit) {
        val rt = PluginRuntime.get(activity)
        rt.io.execute {
            // begin() answers every failure itself; this keeps a defect anywhere else from killing the io thread unanswered.
            val begin = try {
                rt.handoff.begin(orgId, target)
            } catch (e: Exception) {
                Begin.Failed(SignInOutcome.SecureStorageFailed)
            }
            main.post {
                when (begin) {
                    is Begin.Failed -> done(begin.outcome)
                    is Begin.Launch -> {
                        waiting?.invoke(SignInOutcome.Cancelled)
                        waiting = done
                        generation++
                        launcher.launch(begin.url, rt.mode, begin.state)
                    }
                }
            }
        }
    }

    /** A callback URI; [launch] when it came back through that Auth Tab launch's own result. */
    fun onRedirect(activity: android.content.Context, uri: String, launch: String? = null) {
        val rt = PluginRuntime.get(activity)
        rt.io.execute { deliver(settled { rt.handoff.onRedirect(uri, launch) }) }
    }

    /** An Auth Tab result, for the launch named [state] (its own registry entry). */
    fun onAuthTabResult(activity: android.content.Context, state: String, result: AuthTabIntent.AuthResult) = when (result.resultCode) {
        AuthTabIntent.RESULT_OK -> result.resultUri?.let { onRedirect(activity, it.toString(), state) } ?: onCancelSoon(activity, state)
        AuthTabIntent.RESULT_VERIFICATION_FAILED, AuthTabIntent.RESULT_VERIFICATION_TIMED_OUT -> {
            val rt = PluginRuntime.get(activity)
            rt.io.execute { deliver(settled { rt.handoff.onVerificationFailed(state) }) }
        }
        else -> onCancelSoon(activity, state)
    }

    /**
     * Auth Tab cancelled ([state]: that launch's), or the host came back with no result (none: a
     * plain Custom Tab): wait for a late redirect intent, then end it as cancelled.
     */
    fun onCancelSoon(activity: android.content.Context, state: String? = null) {
        val rt = PluginRuntime.get(activity)
        val gen = generation
        main.postDelayed({
            if (waiting != null && (state != null || gen == generation)) rt.io.execute { deliver(settled { rt.handoff.onCancelled(state) }) }
        }, GRACE_MS)
    }

    /** The launch named [state] found no browser to open. */
    fun onNoBrowser(activity: android.content.Context, state: String) {
        val rt = PluginRuntime.get(activity)
        rt.io.execute { deliver(settled { rt.handoff.onNoBrowser(state) }) }
    }

    fun inFlight() = waiting != null

    /** An ending that threw still reaches the waiting caller, as a storage failure. */
    private inline fun settled(ending: () -> SignInOutcome?): SignInOutcome? = try {
        ending()
    } catch (e: Exception) {
        SignInOutcome.SecureStorageFailed
    }

    private fun deliver(outcome: SignInOutcome?) {
        outcome ?: return
        main.post {
            val w = waiting
            waiting = null
            w?.invoke(outcome)
        }
    }
}
