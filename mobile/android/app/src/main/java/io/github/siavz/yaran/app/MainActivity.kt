/**
 * MainActivity: the Capacitor host for the bundled shell, hardened for yaran.
 *
 * Hosts the one bridge-enabled WebView (D9). Around Capacitor's own setup it draws edge to
 * edge, follows the system font size through the WebView's text zoom, applies screen privacy
 * before the first frame, and puts a native cover over the shell whenever the app lock is
 * engaged, prompting once when the lock engages and again on the cover's Unlock button.
 *
 * - WebView debugging is on only in the `e2e` build type (Phase 19 hook H4).
 * - [textZoomFor] is the pure font-scale mapping the unit tests pin.
 * - Plugins are registered by `cap sync` (capacitor.plugins.json), not here.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.app.MainActivity
 * ├── io.github.siavz.yaran.core.AppLock
 * └── io.github.siavz.yaran.core.ScreenPrivacy
 * External: android.os, android.view, android.webkit, android.widget, androidx.activity, androidx.core.content, com.getcapacitor, kotlin.math
 *
 * Used by: entry point (launcher Activity, mobile/android/app/src/main/AndroidManifest.xml)
 * io.github.siavz.yaran.app.MainActivity
 * └── io.github.siavz.yaran.app.TextZoomTest (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.app

import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.enableEdgeToEdge
import androidx.core.content.ContextCompat
import com.getcapacitor.BridgeActivity
import io.github.siavz.yaran.core.AppLock
import io.github.siavz.yaran.core.ScreenPrivacy
import kotlin.math.roundToInt

/** The WebView text zoom (percent) for a system font scale, clamped to what stays usable. */
fun textZoomFor(fontScale: Float): Int =
    if (fontScale.isNaN() || fontScale <= 0f) {
        DEFAULT_TEXT_ZOOM
    } else {
        (fontScale * DEFAULT_TEXT_ZOOM).roundToInt().coerceIn(MIN_TEXT_ZOOM, MAX_TEXT_ZOOM)
    }

private const val DEFAULT_TEXT_ZOOM = 100
private const val MIN_TEXT_ZOOM = 50
private const val MAX_TEXT_ZOOM = 300

class MainActivity : BridgeActivity() {
    private val appLock by lazy { AppLock.shared(this) }
    private var cover: View? = null
    private var promptPending = false
    private val onLockChanged: (Boolean) -> Unit = { locked -> runOnUiThread { showCover(locked) } }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        ScreenPrivacy.install(this)
        super.onCreate(savedInstanceState)
        if (BuildConfig.E2E_WEBVIEW_DEBUG) WebView.setWebContentsDebuggingEnabled(true)
        bridge?.webView?.settings?.textZoom = textZoomFor(resources.configuration.fontScale)
        appLock.addListener(onLockChanged)
        showCover(appLock.locked)
        promptPending = appLock.locked
    }

    override fun onResume() {
        super.onResume()
        val wasLocked = appLock.locked
        if (appLock.onForeground() && !wasLocked) promptPending = true
        if (promptPending) {
            promptPending = false
            unlock()
        }
    }

    override fun onStop() {
        super.onStop()
        if (!isChangingConfigurations) appLock.onBackground()
    }

    override fun onDestroy() {
        appLock.removeListener(onLockChanged)
        super.onDestroy()
    }

    private fun unlock() = appLock.unlock(this) { /* the listener moves the cover; a cancel leaves it up */ }

    private fun showCover(locked: Boolean) {
        val webView = bridge?.webView
        webView?.importantForAccessibility =
            if (locked) View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS else View.IMPORTANT_FOR_ACCESSIBILITY_AUTO
        if (!locked) {
            cover?.let { (it.parent as? ViewGroup)?.removeView(it) }
            cover = null
            return
        }
        if (cover != null) return
        val content =
            LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                gravity = Gravity.CENTER
                addView(
                    TextView(this@MainActivity).apply {
                        setText(R.string.lock_cover_message)
                        setTextColor(ContextCompat.getColor(this@MainActivity, R.color.yaran_foreground))
                        textSize = COVER_TEXT_SP
                        gravity = Gravity.CENTER
                    },
                )
                addView(
                    Button(this@MainActivity).apply {
                        setText(R.string.lock_cover_unlock)
                        setOnClickListener { unlock() }
                    },
                )
            }
        cover =
            FrameLayout(this).apply {
                setBackgroundColor(ContextCompat.getColor(this@MainActivity, R.color.yaran_background))
                isClickable = true
                isFocusable = true
                addView(content, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            }
        addContentView(cover, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    }

    private companion object {
        const val COVER_TEXT_SP = 18f
    }
}
