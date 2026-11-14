/**
 * AuthSpike: the G13 Android probe for the verified https callback and the dev custom scheme.
 *
 * Builds the consent URL from a pasted consent host, then opens it in an Auth Tab (https
 * redirect for the release-shaped run, `redirectScheme` `yaranapp-gate` for the dev-shaped
 * run) or, when Auth Tab is unsupported or the operator forces it, a plain Custom Tab that
 * returns through the App Link / intent-filter [AuthCallbackActivity]. Every result records
 * WHICH path delivered it, so the per-browser table in the gate evidence can be filled in.
 *
 * - Logs parameter names, the `state` check and the presence of `jwe`/`error`; never the `jwe`
 *   value and never the full callback URL.
 * - `state` is 32 random bytes, base64url, kept in memory only for the life of the process.
 * - Reports `CustomTabsClient.isAuthTabSupported` for the default browser and, on API 31+,
 *   the `DomainVerificationManager` state of the callback host.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.gatespike.AuthSpike
 * └── io.github.siavz.yaran.gatespike.MachineViewSpike (inferred)  (TAG)
 * External: android.content, android.content.pm, android.content.pm.verify.domain, android.net, android.os, android.util, android.widget, androidx.activity.result, androidx.appcompat.app, androidx.browser.auth, androidx.browser.customtabs, com.getcapacitor, com.getcapacitor.annotation, java.lang.ref, java.security
 *
 * Used by:
 * io.github.siavz.yaran.gatespike.AuthSpike
 * └── io.github.siavz.yaran.gatespike.MainActivity (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.gatespike

import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.verify.domain.DomainVerificationManager
import android.content.pm.verify.domain.DomainVerificationUserState
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Base64
import android.util.Log
import android.widget.TextView
import androidx.activity.result.ActivityResultLauncher
import androidx.appcompat.app.AppCompatActivity
import androidx.browser.auth.AuthTabIntent
import androidx.browser.customtabs.CustomTabsClient
import androidx.browser.customtabs.CustomTabsIntent
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.lang.ref.WeakReference
import java.security.SecureRandom

private const val DEV_SCHEME = "yaranapp-gate"
private const val CALLBACK_PATH = "/auth/callback"
private val HOST_SHAPE = Regex("^[A-Za-z0-9.-]+(:[0-9]{1,5})?$")

@CapacitorPlugin(name = "AuthSpike")
class AuthSpike : Plugin() {
    private lateinit var authTabLauncher: ActivityResultLauncher<Intent>

    override fun load() {
        instance = WeakReference(this)
        // Registered during BridgeActivity.onCreate (plugin load), i.e. before STARTED.
        authTabLauncher = AuthTabIntent.registerActivityResultLauncher(activity) { result ->
            report(summarizeCallback(result.resultUri, "authTab ${resultName(result.resultCode)}"))
        }
    }

    @PluginMethod
    fun info(call: PluginCall) {
        val browser = defaultBrowserPackage()
        val res = JSObject()
            .put("defaultBrowser", browser ?: "none (no default set)")
            .put("customTabsPackage", CustomTabsClient.getPackageName(context, null) ?: "none")
            .put("authTabSupported", browser != null && CustomTabsClient.isAuthTabSupported(context, browser))
            .put("ephemeralSupported", browser != null && CustomTabsClient.isEphemeralBrowsingSupported(context, browser))
            .put("callbackHost", BuildConfig.GATE_CALLBACK_HOST)
            .put("domainVerification", domainVerificationState())
            .put("sdkInt", Build.VERSION.SDK_INT)
        Log.i(TAG, "authInfo $res")
        call.resolve(res)
    }

    @PluginMethod
    fun start(call: PluginCall) {
        val consentHost = call.getString("consentHost").orEmpty()
        if (!HOST_SHAPE.matches(consentHost)) {
            call.reject("consentHost must be a bare host name such as gate-cp.<staging-zone>")
            return
        }
        val dev = call.getString("mode") == "dev"
        val ephemeral = call.getBoolean("ephemeral", false) == true
        val callbackHost = BuildConfig.GATE_CALLBACK_HOST
        val redirect = if (dev) "$DEV_SCHEME://auth/callback" else "https://$callbackHost$CALLBACK_PATH"
        val state = ByteArray(32).also { SecureRandom().nextBytes(it) }
            .let { Base64.encodeToString(it, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP) }
        pendingState = state
        val consent = Uri.Builder().scheme("https").encodedAuthority(consentHost).path("/v1/handoff")
            .appendQueryParameter("state", state)
            .appendQueryParameter("redirect", redirect)
            .appendQueryParameter("build", if (dev) "dev" else "release")
            .appendQueryParameter("device", call.getString("deviceLabel") ?: "gate-device")
            .build()
        val browser = defaultBrowserPackage()
        val useAuthTab = call.getBoolean("forceCustomTab", false) != true &&
            browser != null && CustomTabsClient.isAuthTabSupported(context, browser)
        activity.runOnUiThread {
            try {
                val via = if (useAuthTab) {
                    val tab = AuthTabIntent.Builder().setEphemeralBrowsingEnabled(ephemeral).build()
                    if (dev) tab.launch(authTabLauncher, consent, DEV_SCHEME)
                    else tab.launch(authTabLauncher, consent, callbackHost, CALLBACK_PATH)
                    "authTab"
                } else {
                    CustomTabsIntent.Builder().setEphemeralBrowsingEnabled(ephemeral).build()
                        .launchUrl(activity, consent)
                    "customTab"
                }
                Log.i(TAG, "authStart via=$via build=${if (dev) "dev" else "release"} ephemeral=$ephemeral browser=$browser redirect=$redirect")
                call.resolve(JSObject().put("via", via).put("consentUrlHost", consentHost))
            } catch (e: ActivityNotFoundException) {
                call.reject("no browser can open the consent page: ${e.message}")
            }
        }
    }

    private fun defaultBrowserPackage(): String? {
        val probe = Intent(Intent.ACTION_VIEW, Uri.parse("https://example.invalid/"))
        // "android" is the disambiguation chooser, i.e. no default browser is set.
        return context.packageManager.resolveActivity(probe, PackageManager.MATCH_DEFAULT_ONLY)
            ?.activityInfo?.packageName?.takeIf { it != "android" }
    }

    private fun domainVerificationState(): String {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return "n/a (API ${Build.VERSION.SDK_INT} < 31)"
        val host = BuildConfig.GATE_CALLBACK_HOST
        val manager = context.getSystemService(DomainVerificationManager::class.java)
        val state = try {
            manager.getDomainVerificationUserState(context.packageName)
        } catch (e: PackageManager.NameNotFoundException) {
            null
        } ?: return "$host=no state"
        val name = when (val code = state.hostToStateMap[host]) {
            DomainVerificationUserState.DOMAIN_STATE_NONE -> "none"
            DomainVerificationUserState.DOMAIN_STATE_SELECTED -> "selected"
            DomainVerificationUserState.DOMAIN_STATE_VERIFIED -> "verified"
            null -> "not declared"
            else -> "unknown($code)"
        }
        return "$host=$name linkHandlingAllowed=${state.isLinkHandlingAllowed}"
    }

    companion object {
        @Volatile private var pendingState: String? = null
        @Volatile private var instance: WeakReference<AuthSpike>? = null

        /** What arrived, without the secret: names, the state check, jwe/error presence. */
        fun summarizeCallback(uri: Uri?, path: String): JSObject {
            val res = JSObject().put("path", path)
            if (uri == null) {
                return res.put("paramNames", JSArray()).put("stateOk", false).put("hasJwe", false)
                    .put("hasError", false).put("detail", "no result URI")
            }
            val names = uri.queryParameterNames
            val error = uri.getQueryParameter("error")
            val expected = pendingState
            res.put("paramNames", JSArray(names.toList()))
                .put("stateOk", expected != null && uri.getQueryParameter("state") == expected)
                .put("hasJwe", "jwe" in names)
                .put("hasError", error != null)
                .put("detail", "${uri.scheme}://${uri.host}${uri.path}")
            if (error != null) res.put("error", error.take(64))
            return res
        }

        fun report(summary: JSObject) {
            Log.i(TAG, "authResult $summary")
            instance?.get()?.notifyListeners("authResult", summary, true)
        }

        private fun resultName(code: Int): String = when (code) {
            AuthTabIntent.RESULT_OK -> "RESULT_OK"
            AuthTabIntent.RESULT_CANCELED -> "RESULT_CANCELED"
            AuthTabIntent.RESULT_VERIFICATION_FAILED -> "RESULT_VERIFICATION_FAILED"
            AuthTabIntent.RESULT_VERIFICATION_TIMED_OUT -> "RESULT_VERIFICATION_TIMED_OUT"
            else -> "RESULT_UNKNOWN($code)"
        }
    }
}

/** App Link (`https://<callback-host>/auth/callback`) and dev-scheme receiver. */
class AuthCallbackActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        handle(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    private fun handle(intent: Intent) {
        val summary = AuthSpike.summarizeCallback(intent.data, "intentFilter ${intent.data?.scheme}")
        AuthSpike.report(summary)
        setContentView(TextView(this).apply {
            text = "Callback delivered to $packageName via the intent filter\n\n${summary.toString(2)}"
            setTextIsSelectable(true)
            setPadding(48, 160, 48, 48)
        })
    }
}
