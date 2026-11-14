/**
 * MachineViewSpike: the G1/G3/G6/G12 probe for an in-process, bridge-free machine WebView.
 *
 * The plugin takes a pasted Access JWT, writes it into the process-wide `CookieManager` as a
 * host-only `CF_Authorization` cookie, and only in the `setCookie` callback starts
 * [MachineViewSpikeActivity], a plain `WebView` in the SAME process with no JavaScript
 * interface. The operator then reads navigation, XHR and socket results from the page and
 * logcat (tag `GateSpike`). `fileChooser=native` and `imeInsets=apply` switch on the G6
 * fallbacks so both behaviours can be compared without a rebuild.
 *
 * - Trust boundary: the JWT comes only from the shell's paste field. It is validated as three
 *   base64url segments (so it cannot smuggle cookie attributes), never logged, never put in an
 *   Intent (Intents are persisted with the task), and never returned to JavaScript.
 * - [buildAccessCookie] is pure JVM code so JUnit can pin its attributes without Android.
 * - `CookieManager` calls run on the main thread; the Activity owns its WebView's lifecycle.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.gatespike.MachineViewSpike
 * └── io.github.siavz.yaran.gatespike.BuildConfig
 * External: android.webkit, androidx.activity, androidx.appcompat, androidx.core, com.getcapacitor
 *
 * Used by:
 * io.github.siavz.yaran.gatespike.MachineViewSpike
 * ├── io.github.siavz.yaran.gatespike.MainActivity
 * ├── io.github.siavz.yaran.gatespike.AuthSpike           (TAG)
 * ├── io.github.siavz.yaran.gatespike.PushSpike           (TAG)
 * └── io.github.siavz.yaran.gatespike.AccessCookieTest
 * <module-headers:end>
 */
package io.github.siavz.yaran.gatespike

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.util.Log
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.ByteArrayOutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

internal const val TAG = "GateSpike"

private val JWT_SHAPE = Regex("^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$")
private val SAME_SITE_VALUES = setOf("Strict", "Lax", "None")
private const val B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

/**
 * The `Set-Cookie`-shaped value machine-view injects: host-only (no Domain), `Path=/`,
 * Secure, HttpOnly, the given SameSite, and Expires at the JWT's own `exp` (G1 L0).
 */
fun buildAccessCookie(jwt: String, sameSite: String, expEpochSeconds: Long? = null): String {
    require(JWT_SHAPE.matches(jwt)) { "not a JWT: expected three base64url segments" }
    require(sameSite in SAME_SITE_VALUES) { "SameSite must be one of $SAME_SITE_VALUES" }
    val exp = expEpochSeconds ?: jwtExp(jwt)
    return "CF_Authorization=$jwt; Path=/; Secure; HttpOnly; SameSite=$sameSite; Expires=${rfc1123(exp)}"
}

/** Reads `exp` from the (unverified) JWT payload; the server verifies, the spike only schedules. */
fun jwtExp(jwt: String): Long {
    val parts = jwt.split('.')
    require(parts.size == 3) { "not a JWT: expected three segments" }
    val payload = String(base64UrlDecode(parts[1]), Charsets.UTF_8)
    // shortcut: regex, not a JSON parser (org.json is stubbed in JVM tests); Access payloads are flat.
    val match = Regex("\"exp\"\\s*:\\s*(\\d+)").find(payload)
        ?: throw IllegalArgumentException("JWT payload has no numeric exp")
    return match.groupValues[1].toLong()
}

/** RFC 1123 date in GMT, the `Expires` form browsers parse. */
fun rfc1123(epochSeconds: Long): String =
    SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss 'GMT'", Locale.US)
        .apply { timeZone = TimeZone.getTimeZone("UTC") }
        .format(Date(epochSeconds * 1000))

// java.util.Base64 needs API 26 and android.util.Base64 is stubbed in JVM tests; minSdk is 24.
internal fun base64UrlDecode(s: String): ByteArray {
    val out = ByteArrayOutputStream()
    var buf = 0
    var bits = 0
    for (c in s) {
        val v = B64URL.indexOf(c)
        require(v >= 0) { "invalid base64url character" }
        buf = ((buf shl 6) or v) and 0xFFFF
        bits += 6
        if (bits >= 8) {
            bits -= 8
            out.write((buf shr bits) and 0xFF)
        }
    }
    return out.toByteArray()
}

@CapacitorPlugin(name = "MachineViewSpike")
class MachineViewSpike : Plugin() {
    @PluginMethod
    fun open(call: PluginCall) {
        val url = call.getString("url").orEmpty()
        val target = Uri.parse(url)
        val host = target.host
        if (target.scheme != "https" || host.isNullOrEmpty()) {
            call.reject("url must be https://<machine-host>/")
            return
        }
        val cookie = try {
            buildAccessCookie(call.getString("jwt").orEmpty(), call.getString("sameSite") ?: "Lax")
        } catch (e: IllegalArgumentException) {
            call.reject(e.message)
            return
        }
        val expires = cookie.substringAfter("Expires=")
        // Set against the origin with no Domain attribute, so the cookie is host-only.
        val cookieUrl = "https://$host/"
        val launch = Intent(context, MachineViewSpikeActivity::class.java)
            .putExtra(EXTRA_URL, url)
            .putExtra(EXTRA_FILE_CHOOSER, call.getString("fileChooser") ?: "default")
            .putExtra(EXTRA_IME, call.getString("imeInsets") ?: "default")
        activity.runOnUiThread {
            val cookies = CookieManager.getInstance()
            cookies.setAcceptCookie(true)
            cookies.setCookie(cookieUrl, cookie) { ok ->
                cookies.flush()
                Log.i(TAG, "setCookie host=$host ok=$ok expires=$expires")
                if (!ok) {
                    call.reject("CookieManager refused the cookie for $host")
                    return@setCookie
                }
                // G1 step 2: load only once the cookie store has acknowledged the write.
                activity.startActivity(launch)
                call.resolve(JSObject().put("cookieUrl", cookieUrl).put("expires", expires))
            }
        }
    }

    companion object {
        const val EXTRA_URL = "url"
        const val EXTRA_FILE_CHOOSER = "fileChooser"
        const val EXTRA_IME = "imeInsets"
    }
}

/** Same-process host for the machine WebView. Deliberately no `addJavascriptInterface`. */
class MachineViewSpikeActivity : AppCompatActivity() {
    private var web: WebView? = null
    private var pendingChooser: ValueCallback<Array<Uri>>? = null
    private var chooserIsMultiple = false

    // G6 fallback: registered unconditionally (must happen before STARTED), used only when asked.
    private val pickDocuments =
        registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
            val picked = if (chooserIsMultiple) uris else uris.take(1)
            Log.i(TAG, "fileChooser native returned ${picked.size} uri(s)")
            pendingChooser?.onReceiveValue(if (picked.isEmpty()) null else picked.toTypedArray())
            pendingChooser = null
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val url = intent.getStringExtra(MachineViewSpike.EXTRA_URL)
        if (url == null) {
            finish()
            return
        }
        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)
        val view = WebView(this)
        view.settings.javaScriptEnabled = true
        view.settings.domStorageEnabled = true
        view.webViewClient = LoggingViewClient()
        val nativeChooser = intent.getStringExtra(MachineViewSpike.EXTRA_FILE_CHOOSER) == "native"
        view.webChromeClient = if (nativeChooser) NativeChooserClient() else LoggingChromeClient()
        Log.i(TAG, "machine-view fileChooser=${if (nativeChooser) "native" else "platform-default"}")

        val root = FrameLayout(this)
        root.addView(view, FrameLayout.LayoutParams(-1, -1))
        val applyIme = intent.getStringExtra(MachineViewSpike.EXTRA_IME) == "apply"
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            Log.i(TAG, "insets ime=$ime systemBars=$bars imeVisible=${insets.isVisible(WindowInsetsCompat.Type.ime())} apply=$applyIme")
            if (applyIme) {
                // G6 Android IME fallback: shrink the WebView frame ourselves and consume.
                v.setPadding(bars.left, bars.top, bars.right, maxOf(ime.bottom, bars.bottom))
                WindowInsetsCompat.CONSUMED
            } else {
                insets
            }
        }
        setContentView(root)
        web = view
        view.loadUrl(url)
    }

    override fun onDestroy() {
        pendingChooser?.onReceiveValue(null)
        web?.destroy()
        web = null
        super.onDestroy()
    }

    private class LoggingViewClient : WebViewClient() {
        override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
            Log.i(TAG, "pageStarted ${where(url)}")
        }

        override fun onPageFinished(view: WebView, url: String) {
            Log.i(TAG, "pageFinished ${where(url)}")
        }

        override fun onReceivedHttpError(view: WebView, req: WebResourceRequest, resp: WebResourceResponse) {
            Log.i(TAG, "httpError ${resp.statusCode} mainFrame=${req.isForMainFrame} ${where(req.url.toString())}")
        }

        // Host and path only: query strings on Access redirects are not evidence we need.
        private fun where(url: String): String = Uri.parse(url).let { "${it.host}${it.path}" }
    }

    private open class LoggingChromeClient : WebChromeClient() {
        override fun onConsoleMessage(message: ConsoleMessage): Boolean {
            Log.i(TAG, "console ${message.messageLevel()}: ${message.message()}")
            return true
        }
    }

    private inner class NativeChooserClient : LoggingChromeClient() {
        override fun onShowFileChooser(
            view: WebView,
            callback: ValueCallback<Array<Uri>>,
            params: FileChooserParams,
        ): Boolean {
            pendingChooser?.onReceiveValue(null)
            pendingChooser = callback
            chooserIsMultiple = params.mode == FileChooserParams.MODE_OPEN_MULTIPLE
            // accept may hold extensions (".png"); OpenDocument wants MIME types, so widen those.
            val mimes = params.acceptTypes.filter { it.isNotBlank() }
            val types = if (mimes.isEmpty() || mimes.any { '/' !in it }) arrayOf("*/*") else mimes.toTypedArray()
            Log.i(TAG, "fileChooser native accept=${types.joinToString()} capture=${params.isCaptureEnabled}")
            pickDocuments.launch(types)
            return true
        }
    }
}
