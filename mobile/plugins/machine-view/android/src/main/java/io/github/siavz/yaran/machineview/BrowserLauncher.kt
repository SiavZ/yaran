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
 * ├── io.github.siavz.yaran.machineview.MachineViewActivity (inferred)
 * └── io.github.siavz.yaran.machineview.SessionPlugin (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

import android.content.ActivityNotFoundException
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
    private val authTab: ActivityResultLauncher<Intent> =
        AuthTabIntent.registerActivityResultLauncher(activity) { result ->
            when (result.resultCode) {
                AuthTabIntent.RESULT_OK -> result.resultUri?.let { SignInFlow.onRedirect(activity, it.toString()) } ?: SignInFlow.onCancelSoon(activity)
                AuthTabIntent.RESULT_VERIFICATION_FAILED, AuthTabIntent.RESULT_VERIFICATION_TIMED_OUT -> SignInFlow.onVerificationFailed(activity)
                else -> SignInFlow.onCancelSoon(activity)
            }
        }

    fun launch(url: String, mode: CallbackMode) {
        val uri = Uri.parse(url)
        val browser = CustomTabsClient.getPackageName(activity, null)
        try {
            when {
                browser != null && CustomTabsClient.isAuthTabSupported(activity, browser) -> {
                    val tab = AuthTabIntent.Builder().build()
                    tab.intent.setPackage(browser)
                    when (mode) {
                        is CallbackMode.Https -> tab.launch(authTab, uri, mode.domain, CALLBACK_PATH)
                        CallbackMode.Dev -> tab.launch(authTab, uri, DEV_SCHEME)
                    }
                }
                browser != null -> CustomTabsIntent.Builder().build().apply { intent.setPackage(browser) }.launchUrl(activity, uri)
                else -> SignInFlow.onNoBrowser(activity)
            }
        } catch (e: ActivityNotFoundException) {
            SignInFlow.onNoBrowser(activity)
        }
    }

    companion object {
        const val CALLBACK_PATH = "/auth/callback"
        const val DEV_SCHEME = "yaranapp"
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
            val begin = rt.handoff.begin(orgId, target)
            main.post {
                when (begin) {
                    is Begin.Failed -> done(begin.outcome)
                    is Begin.Launch -> {
                        waiting?.invoke(SignInOutcome.Cancelled)
                        waiting = done
                        generation++
                        launcher.launch(begin.url, rt.mode)
                    }
                }
            }
        }
    }

    fun onRedirect(activity: android.content.Context, uri: String) {
        val rt = PluginRuntime.get(activity)
        rt.io.execute { deliver(rt.handoff.onRedirect(uri)) }
    }

    /** Auth Tab cancelled, or the host came back with no result: wait for a late redirect intent. */
    fun onCancelSoon(activity: android.content.Context) {
        val rt = PluginRuntime.get(activity)
        val gen = generation
        main.postDelayed({ if (waiting != null && gen == generation) rt.io.execute { deliver(rt.handoff.onCancelled()) } }, GRACE_MS)
    }

    fun onVerificationFailed(activity: android.content.Context) {
        val rt = PluginRuntime.get(activity)
        rt.io.execute { deliver(rt.handoff.onVerificationFailed()) }
    }

    fun onNoBrowser(activity: android.content.Context) {
        val rt = PluginRuntime.get(activity)
        rt.io.execute { deliver(rt.handoff.onNoBrowser()) }
    }

    fun inFlight() = waiting != null

    private fun deliver(outcome: SignInOutcome?) {
        outcome ?: return
        main.post {
            val w = waiting
            waiting = null
            w?.invoke(outcome)
        }
    }
}
